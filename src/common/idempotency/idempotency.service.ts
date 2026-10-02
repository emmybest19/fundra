// Makes money-moving requests safe to retry: the same Idempotency-Key never executes twice.
// Design and failure analysis: docs/ARCHITECTURE.md, "Idempotency".
import { ConflictError, ErrorCode, UnprocessableError } from '../errors/index.ts';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
/** An IN_PROGRESS claim older than this is assumed abandoned (its process crashed). */
export const IDEMPOTENCY_LEASE_MS = 60_000;
const MAX_CLAIM_ATTEMPTS = 3;

export interface IdempotentRequest {
  userId: string;
  key: string;
  /** From requestFingerprint(): same key + different fingerprint is rejected. */
  fingerprint: string;
}

/** What the work produces. `body` must be JSON-serializable (amounts as strings, never bigint). */
export interface IdempotentOutcome {
  status: number;
  body: unknown;
  /** The financial transaction created, if any; stored for support and reconciliation. */
  transactionId?: string;
}

export interface IdempotentResult {
  status: number;
  body: unknown;
  /** True when this response is a replay of an earlier, completed request. */
  replayed: boolean;
}

type Claim =
  { kind: 'claimed'; id: string; claimedAt: Date } | { kind: 'replay'; result: IdempotentResult };

export interface IdempotencyOptions {
  ttlMs?: number;
  leaseMs?: number;
  now?: () => number;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
}

export class IdempotencyService {
  readonly #db: PrismaClient;
  readonly #ttlMs: number;
  readonly #leaseMs: number;
  readonly #now: () => number;

  constructor(db: PrismaClient, options: IdempotencyOptions = {}) {
    this.#db = db;
    this.#ttlMs = options.ttlMs ?? IDEMPOTENCY_TTL_MS;
    this.#leaseMs = options.leaseMs ?? IDEMPOTENCY_LEASE_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Runs `work` at most once per (user, key). The work runs inside a database transaction,
   * and the key is marked COMPLETED (with the response) in that same transaction, so
   * "money moved" and "key completed" can never disagree:
   * - completed key → the stored response is replayed and `work` does not run;
   * - work or COMMIT fails → nothing was committed, the claim is released, retry is safe.
   */
  async run(
    request: IdempotentRequest,
    work: (tx: Prisma.TransactionClient) => Promise<IdempotentOutcome>,
  ): Promise<IdempotentResult> {
    const claim = await this.#claim(request);
    if (claim.kind === 'replay') return claim.result;

    try {
      return await this.#db.$transaction(async (tx) => {
        await this.#assertStillOwner(tx, claim);
        const outcome = await work(tx);
        // Round-trip through JSON now: a non-serializable body (e.g. a bigint) must fail
        // before COMMIT, not leave money moved with a response we can't replay.
        const body = JSON.parse(JSON.stringify(outcome.body)) as Prisma.InputJsonValue;
        await tx.idempotencyKey.update({
          where: { id: claim.id },
          data: {
            status: 'COMPLETED',
            responseStatus: outcome.status,
            responseBody: body,
            transactionId: outcome.transactionId ?? null,
          },
        });
        return { status: outcome.status, body, replayed: false };
      });
    } catch (err) {
      // Nothing committed: free the key so the client can retry. Only our own claim is
      // removed (a takeover has a different claimedAt; a completed key is not IN_PROGRESS).
      await this.#db.idempotencyKey.deleteMany({
        where: { id: claim.id, status: 'IN_PROGRESS', claimedAt: claim.claimedAt },
      });
      throw err;
    }
  }

  async #claim(request: IdempotentRequest): Promise<Claim> {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const now = this.#now();
      try {
        const row = await this.#db.idempotencyKey.create({
          data: {
            userId: request.userId,
            key: request.key,
            requestHash: request.fingerprint,
            claimedAt: new Date(now),
            expiresAt: new Date(now + this.#ttlMs),
          },
        });
        return { kind: 'claimed', id: row.id, claimedAt: row.claimedAt };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }

      const existing = await this.#db.idempotencyKey.findUnique({
        where: { userId_key: { userId: request.userId, key: request.key } },
      });
      if (existing === null) continue; // deleted between our insert and read: try again

      if (existing.expiresAt.getTime() <= now) {
        // Expired keys may be reused for anything; remove it (if unchanged) and claim afresh.
        await this.#db.idempotencyKey.deleteMany({
          where: { id: existing.id, expiresAt: existing.expiresAt },
        });
        continue;
      }

      if (existing.requestHash !== request.fingerprint) {
        throw new UnprocessableError(
          'This Idempotency-Key was already used for a different request. Use a new key.',
          { code: ErrorCode.IDEMPOTENCY_KEY_REUSED },
        );
      }

      if (existing.status === 'COMPLETED') {
        return {
          kind: 'replay',
          result: {
            status: existing.responseStatus ?? 200,
            body: existing.responseBody,
            replayed: true,
          },
        };
      }

      if (now - existing.claimedAt.getTime() < this.#leaseMs) {
        throw new ConflictError(
          'A request with this Idempotency-Key is still being processed. Retry shortly.',
          { code: ErrorCode.IDEMPOTENCY_REQUEST_IN_PROGRESS },
        );
      }

      // Stale claim: its process most likely died before committing (a commit would have
      // marked it COMPLETED). Take it over atomically; the old owner, if still alive, is
      // fenced out by #assertStillOwner.
      const takenAt = new Date(now);
      const { count } = await this.#db.idempotencyKey.updateMany({
        where: { id: existing.id, status: 'IN_PROGRESS', claimedAt: existing.claimedAt },
        data: { claimedAt: takenAt },
      });
      if (count === 1) return { kind: 'claimed', id: existing.id, claimedAt: takenAt };
    }

    throw new ConflictError('Could not acquire the Idempotency-Key. Retry shortly.', {
      code: ErrorCode.IDEMPOTENCY_REQUEST_IN_PROGRESS,
    });
  }

  /**
   * Fencing: lock our idempotency row as the first statement of the money transaction and
   * verify we still own it. A takeover then has to wait for our COMMIT (and will see
   * COMPLETED), or, if it happened first, we abort here before touching any money.
   */
  async #assertStillOwner(
    tx: Prisma.TransactionClient,
    claim: { id: string; claimedAt: Date },
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string; claimed_at: Date }[]>`
      SELECT status, claimed_at FROM idempotency_keys WHERE id = ${claim.id}::uuid FOR UPDATE`;
    const row = rows[0];
    if (row?.status !== 'IN_PROGRESS' || row.claimed_at.getTime() !== claim.claimedAt.getTime()) {
      throw new ConflictError(
        'This request was superseded by a retry with the same Idempotency-Key.',
        { code: ErrorCode.IDEMPOTENCY_REQUEST_IN_PROGRESS },
      );
    }
  }
}
