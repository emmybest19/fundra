// Business logic for kyc: the three tiers, document uploads and the review decisions
// (docs/ARCHITECTURE.md §6.2). Every status change goes through assertKycTransition.
import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  ServiceUnavailableError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../../common/errors/index.ts';
import { writeOutboxEvent } from '../../common/outbox/outbox.writer.ts';
import { lagosDate } from '../../common/utils/business-day.ts';
import type {
  KycDocument,
  KycDocumentType,
  KycProfile,
  KycStatus,
  Prisma,
  PrismaClient,
} from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditActor, AuditContext } from '../audit/audit.types.ts';
import { detectDocumentType, isDocumentMimeType } from './document-file.ts';
import type { DocumentStorage } from './document-storage.ts';
import type { IdentityNumberCrypto } from './identity-crypto.ts';
import { assertKycTransition, UNDER_REVIEW } from './kyc-status.ts';
import type { Tier2Input, Tier3Input } from './kyc.schema.ts';
import {
  missingTier3Documents,
  toDocumentView,
  toKycOverview,
  type KycDocumentView,
  type KycOverview,
} from './kyc.types.ts';
import {
  KycProviderUnavailableError,
  type DocumentCheckResult,
  type IdentityMismatch,
  type IdentitySubject,
  type KycProvider,
} from './providers/kyc-provider.ts';
import { tierLimitsView } from './tier-limits.ts';

export const MINIMUM_AGE = 18;

/**
 * Shown for every Tier 2 rejection, whatever the cause. Saying "date of birth mismatch" or
 * "already linked to another account" would tell someone holding another person's BVN about
 * that person. The real cause is in the audit log.
 */
export const TIER2_REJECTION_REASON =
  "We couldn't verify this number against your name and date of birth. Check it and try again, or contact support.";

type Tier2Decision =
  | { approved: true; providerReference: string }
  | {
      approved: false;
      cause: 'MISMATCH' | 'NOT_FOUND' | 'DUPLICATE_IDENTITY';
      mismatched?: readonly IdentityMismatch[];
      /** Null when no provider was asked (a duplicate is caught first). */
      providerReference: string | null;
    };

/** What a reviewer sees when opening a case. */
export interface KycReviewCase {
  profileId: string;
  userId: string;
  kyc: KycOverview;
  providerCheck: DocumentCheckResult | null;
}

/** True once the 18th birthday has started. 29 February birthdays count from 1 March. */
export function isAdult(dateOfBirth: string, now: number): boolean {
  const year = Number(dateOfBirth.slice(0, 4));
  return `${String(year + MINIMUM_AGE)}${dateOfBirth.slice(4)}` <= lagosDate(now);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
}

const PROFILE_WITH_DOCUMENTS = {
  documents: { orderBy: { uploadedAt: 'desc' } },
} as const satisfies Prisma.KycProfileInclude;

const conflict = (code: ErrorCode, message: string) => new ConflictError(message, { code });

/** Whether the user may apply for (or upload documents towards) `tier` right now. */
function assertCanApply(profile: Pick<KycProfile, 'tier' | 'status'>, tier: 1 | 2 | 3): void {
  if (profile.tier >= tier) {
    throw conflict(
      ErrorCode.KYC_TIER_ALREADY_APPROVED,
      `You're already verified at Tier ${String(profile.tier)}.`,
    );
  }
  if (profile.tier < tier - 1) {
    throw conflict(ErrorCode.KYC_TIER_ORDER, `Complete Tier ${String(tier - 1)} first.`);
  }
  if (UNDER_REVIEW.includes(profile.status)) {
    throw conflict(
      ErrorCode.KYC_UNDER_REVIEW,
      'Your verification is under review. You can make changes once it has been decided.',
    );
  }
}

export class KycService {
  readonly #db: PrismaClient;
  readonly #provider: KycProvider;
  readonly #storage: DocumentStorage;
  readonly #crypto: IdentityNumberCrypto;
  readonly #now: () => number;

  constructor(
    db: PrismaClient,
    provider: KycProvider,
    storage: DocumentStorage,
    crypto: IdentityNumberCrypto,
    now: () => number = Date.now,
  ) {
    this.#db = db;
    this.#provider = provider;
    this.#storage = storage;
    this.#crypto = crypto;
    this.#now = now;
  }

  async getOverview(userId: string): Promise<KycOverview> {
    return this.#overview(this.#db, { userId });
  }

  /**
   * Tier 1: name (already on the account), verified contacts (the route requires an ACTIVE
   * account) and a date of birth showing the user is 18+. Approved at once; the name locks.
   */
  async submitTier1(
    userId: string,
    dateOfBirth: string,
    context: AuditContext,
  ): Promise<KycOverview> {
    if (!isAdult(dateOfBirth, this.#now())) {
      throw new ValidationError([
        {
          path: 'body.dateOfBirth',
          message: `You must be at least ${String(MINIMUM_AGE)} years old`,
        },
      ]);
    }
    return this.#db.$transaction(async (tx) => {
      const profile = await this.#lockProfile(tx, { userId });
      assertCanApply(profile, 1);
      assertKycTransition(profile.status, 'APPROVED');
      const now = new Date(this.#now());
      await tx.kycProfile.update({
        where: { id: profile.id },
        data: {
          tier: 1,
          status: 'APPROVED',
          requestedTier: null,
          dateOfBirth: new Date(`${dateOfBirth}T00:00:00Z`),
          submittedAt: now,
          reviewedAt: now,
          reviewedByUserId: null,
          rejectionReason: null,
        },
      });
      await this.#recordDecision(tx, profile, {
        action: 'kyc.approved',
        actor: { type: 'USER', userId },
        status: 'APPROVED',
        tier: 1,
        context,
        metadata: { tier: 1, decidedBy: 'AUTOMATIC' },
      });
      return this.#overview(tx, { id: profile.id });
    });
  }

  /**
   * Tier 2: BVN or NIN, checked by the provider and decided at once. The provider is called
   * outside any transaction (it's slow and remote); the decision transaction then re-checks
   * that nothing changed meanwhile. The name and date of birth can't have changed: both are
   * locked from Tier 1. The number is stored, encrypted, only when it matches.
   */
  async submitTier2(
    userId: string,
    input: Tier2Input,
    context: AuditContext,
  ): Promise<KycOverview> {
    const profile = await this.#db.kycProfile.findUniqueOrThrow({
      where: { userId },
      include: { user: { select: { firstName: true, lastName: true } } },
    });
    assertCanApply(profile, 2);
    if (profile.dateOfBirth === null)
      throw new Error(`Tier 1 profile ${profile.id} has no date of birth`);

    const hmac = this.#crypto.hmac(input.type, input.idNumber);
    const taken = await this.#db.kycProfile.findFirst({
      where: {
        ...(input.type === 'BVN' ? { bvnHmac: hmac } : { ninHmac: hmac }),
        NOT: { userId },
      },
      select: { id: true },
    });
    if (taken !== null) {
      // No provider call: it would cost money and the answer can't change the outcome.
      return this.#decideTier2(userId, profile.tier, input, hmac, context, {
        approved: false,
        cause: 'DUPLICATE_IDENTITY',
        providerReference: null,
      });
    }

    const subject: IdentitySubject = {
      firstName: profile.user.firstName,
      lastName: profile.user.lastName,
      dateOfBirth: profile.dateOfBirth.toISOString().slice(0, 10),
    };
    let decision: Tier2Decision;
    try {
      const result = await this.#provider.verifyIdentityNumber({
        type: input.type,
        idNumber: input.idNumber,
        subject,
        reference: `kyc:${profile.id}:tier2:${randomUUID()}`,
      });
      decision =
        result.outcome === 'MATCH'
          ? { approved: true, providerReference: result.providerReference }
          : {
              approved: false,
              cause: result.outcome,
              providerReference: result.providerReference,
              ...(result.outcome === 'MISMATCH' ? { mismatched: result.mismatched } : {}),
            };
    } catch (err) {
      if (!(err instanceof KycProviderUnavailableError)) throw err;
      throw new ServiceUnavailableError(
        'Identity verification is temporarily unavailable. Nothing was saved; please try again shortly.',
        { cause: err },
      );
    }
    return this.#decideTier2(userId, profile.tier, input, hmac, context, decision);
  }

  /**
   * Stores one Tier 3 document. Uploading a type again replaces the earlier upload of that
   * type, as long as nothing is under review. The bytes must be what the Content-Type says.
   */
  async uploadDocument(
    userId: string,
    type: KycDocumentType,
    declaredMimeType: string,
    content: Uint8Array,
    context: AuditContext,
  ): Promise<KycDocumentView> {
    if (content.length === 0) {
      throw new ValidationError([{ path: 'body', message: 'The file is empty' }]);
    }
    if (!isDocumentMimeType(declaredMimeType) || detectDocumentType(content) !== declaredMimeType) {
      throw new UnsupportedMediaTypeError(
        "Upload a JPEG, PNG or PDF, with a Content-Type that matches the file's contents.",
      );
    }
    const profile = await this.#db.kycProfile.findUniqueOrThrow({ where: { userId } });
    assertCanApply(profile, 3);

    // The file goes first: a row must never point at a file that doesn't exist.
    const storageKey = `${profile.id}/${randomUUID()}`;
    await this.#storage.put(storageKey, content);
    let replaced: KycDocument[];
    let document: KycDocument;
    try {
      ({ replaced, document } = await this.#db.$transaction(async (tx) => {
        const current = await this.#lockProfile(tx, { id: profile.id });
        assertCanApply(current, 3);
        // PENDING documents are the current draft; earlier submissions' documents were
        // ACCEPTED or REJECTED by their review and stay as history.
        const previous = await tx.kycDocument.findMany({
          where: { kycProfileId: current.id, type, status: 'PENDING' },
        });
        if (previous.length > 0) {
          await tx.kycDocument.deleteMany({ where: { id: { in: previous.map((d) => d.id) } } });
        }
        const created = await tx.kycDocument.create({
          data: {
            kycProfileId: current.id,
            type,
            storageKey,
            mimeType: declaredMimeType,
            sizeBytes: content.length,
            sha256: createHash('sha256').update(content).digest('hex'),
          },
        });
        await recordAudit(tx, {
          action: 'kyc.document_uploaded',
          actor: { type: 'USER', userId },
          resource: { type: 'kyc_document', id: created.id },
          context,
          metadata: {
            type,
            mimeType: declaredMimeType,
            sizeBytes: content.length,
            replacedDocumentIds: previous.map((d) => d.id),
          },
        });
        return { replaced: previous, document: created };
      }));
    } catch (err) {
      await this.#storage.delete(storageKey).catch(() => undefined);
      throw err;
    }
    // After commit. A failure here leaves an orphaned file, never a missing one.
    await Promise.all(
      replaced.map((d) => this.#storage.delete(d.storageKey).catch(() => undefined)),
    );
    return toDocumentView(document);
  }

  /**
   * Tier 3: the address plus the uploaded documents go to review (PENDING). The documents are
   * also sent to the provider; if it's down, the reviewer's first look sends them instead.
   */
  async submitTier3(
    userId: string,
    input: Tier3Input,
    context: AuditContext,
  ): Promise<KycOverview> {
    const profileId = await this.#db.$transaction(async (tx) => {
      const profile = await this.#lockProfile(tx, { userId });
      assertCanApply(profile, 3);
      assertKycTransition(profile.status, 'PENDING');
      const documents = await tx.kycDocument.findMany({
        where: { kycProfileId: profile.id, status: 'PENDING' },
      });
      const missing = missingTier3Documents(documents.map((d) => d.type));
      if (missing.length > 0) {
        throw new ValidationError([
          { path: 'documents', message: `Upload ${missing.join(' and ')} first` },
        ]);
      }
      const { address } = input;
      await tx.kycProfile.update({
        where: { id: profile.id },
        data: {
          status: 'PENDING',
          requestedTier: 3,
          addressLine1: address.line1,
          addressLine2: address.line2 ?? null,
          city: address.city,
          state: address.state,
          country: address.country,
          postalCode: address.postalCode ?? null,
          submittedAt: new Date(this.#now()),
          reviewedAt: null,
          reviewedByUserId: null,
          rejectionReason: null,
          provider: this.#provider.name,
          providerReference: null,
        },
      });
      await this.#recordDecision(tx, profile, {
        action: 'kyc.submitted',
        actor: { type: 'USER', userId },
        status: 'PENDING',
        tier: profile.tier,
        context,
        metadata: { tier: 3, documentIds: documents.map((d) => d.id) },
      });
      return profile.id;
    });

    await this.#sendDocumentsToProvider(profileId).catch(() => undefined);
    return this.getOverview(userId);
  }

  // ─── Review (service only; admin endpoints arrive in Stage 19) ─────────────────────────

  /**
   * A reviewer opens a queued Tier 3 case: PENDING → IN_REVIEW, assigned to them. Returns the
   * case with the provider's document result (input for the reviewer, not the decision).
   */
  async startReview(
    profileId: string,
    reviewerId: string,
    context: AuditContext,
  ): Promise<KycReviewCase> {
    const profile = await this.#db.kycProfile.findUniqueOrThrow({ where: { id: profileId } });
    assertNotSelfReview(profile, reviewerId);
    if (profile.status === 'PENDING' && profile.providerReference === null) {
      await this.#sendDocumentsToProvider(profileId).catch((err: unknown) => {
        throw new ServiceUnavailableError('The KYC provider is unavailable. Try again shortly.', {
          cause: err,
        });
      });
    }
    await this.#db.$transaction(async (tx) => {
      const current = await this.#lockProfile(tx, { id: profileId });
      assertKycTransition(current.status, 'IN_REVIEW');
      await tx.kycProfile.update({
        where: { id: profileId },
        data: { status: 'IN_REVIEW', reviewedByUserId: reviewerId },
      });
      await this.#recordDecision(tx, current, {
        action: 'kyc.review_started',
        actor: { type: 'ADMIN', userId: reviewerId },
        status: 'IN_REVIEW',
        tier: current.tier,
        context,
        metadata: { tier: 3 },
      });
    });
    return this.#reviewCase(profileId);
  }

  /** Approves Tier 3. The provider must have accepted the documents. */
  async approve(
    profileId: string,
    reviewerId: string,
    context: AuditContext,
  ): Promise<KycOverview> {
    const profile = await this.#db.kycProfile.findUniqueOrThrow({ where: { id: profileId } });
    assertNotSelfReview(profile, reviewerId);
    assertKycTransition(profile.status, 'APPROVED');
    const check =
      profile.providerReference === null
        ? null
        : await this.#provider.getDocumentCheck(profile.providerReference);
    if (check?.status !== 'ACCEPTED') {
      throw conflict(
        ErrorCode.KYC_PROVIDER_CHECK_INCOMPLETE,
        `The provider hasn't accepted these documents (${check?.status ?? 'NOT_SENT'}). Reject the case, or try again once the check is complete.`,
      );
    }
    return this.#db.$transaction(async (tx) => {
      const current = await this.#lockProfile(tx, { id: profileId });
      if (
        current.status !== 'IN_REVIEW' ||
        current.providerReference !== profile.providerReference
      ) {
        throw conflict(
          ErrorCode.KYC_STATE_CHANGED,
          'This case changed while you were reviewing it. Reload it.',
        );
      }
      const now = new Date(this.#now());
      await tx.kycProfile.update({
        where: { id: profileId },
        data: {
          tier: 3,
          status: 'APPROVED',
          requestedTier: null,
          reviewedAt: now,
          reviewedByUserId: reviewerId,
          rejectionReason: null,
        },
      });
      await tx.kycDocument.updateMany({
        where: { kycProfileId: profileId, status: 'PENDING' },
        data: { status: 'ACCEPTED', reviewedAt: now },
      });
      await this.#recordDecision(tx, current, {
        action: 'kyc.approved',
        actor: { type: 'ADMIN', userId: reviewerId },
        status: 'APPROVED',
        tier: 3,
        context,
        metadata: { tier: 3, provider: current.provider, providerStatus: check.status },
      });
      return this.#overview(tx, { id: profileId });
    });
  }

  /** Rejects Tier 3. The reason is shown to the user, so it must say what to fix. */
  async reject(
    profileId: string,
    reviewerId: string,
    reason: string,
    context: AuditContext,
  ): Promise<KycOverview> {
    return this.#db.$transaction(async (tx) => {
      const current = await this.#lockProfile(tx, { id: profileId });
      assertNotSelfReview(current, reviewerId);
      assertKycTransition(current.status, 'REJECTED');
      const now = new Date(this.#now());
      await tx.kycProfile.update({
        where: { id: profileId },
        data: {
          status: 'REJECTED',
          reviewedAt: now,
          reviewedByUserId: reviewerId,
          rejectionReason: reason,
        },
      });
      await tx.kycDocument.updateMany({
        where: { kycProfileId: profileId, status: 'PENDING' },
        data: { status: 'REJECTED', reviewedAt: now },
      });
      await this.#recordDecision(tx, current, {
        action: 'kyc.rejected',
        actor: { type: 'ADMIN', userId: reviewerId },
        status: 'REJECTED',
        tier: current.tier,
        context,
        // The reason is the compliance record of the decision; reviewers write it for the user.
        metadata: { tier: 3, reason },
      });
      return this.#overview(tx, { id: profileId });
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────────────────

  async #decideTier2(
    userId: string,
    expectedTier: number,
    input: Tier2Input,
    hmac: string,
    context: AuditContext,
    decision: Tier2Decision,
  ): Promise<KycOverview> {
    try {
      return await this.#db.$transaction(async (tx) => {
        const current = await this.#lockProfile(tx, { userId });
        if (current.tier !== expectedTier || UNDER_REVIEW.includes(current.status)) {
          throw conflict(
            ErrorCode.KYC_STATE_CHANGED,
            'Your verification changed while this request was running. Check your KYC status and try again.',
          );
        }
        const status: KycStatus = decision.approved ? 'APPROVED' : 'REJECTED';
        assertKycTransition(current.status, status);
        const now = new Date(this.#now());
        const provider = decision.providerReference === null ? null : this.#provider.name;
        const common = {
          submittedAt: now,
          reviewedAt: now,
          reviewedByUserId: null,
          provider,
          providerReference: decision.providerReference,
        };
        await tx.kycProfile.update({
          where: { id: current.id },
          data: decision.approved
            ? {
                ...common,
                tier: 2,
                status,
                requestedTier: null,
                rejectionReason: null,
                ...(input.type === 'BVN'
                  ? {
                      bvnEncrypted: this.#crypto.encrypt(input.idNumber, current.id),
                      bvnHmac: hmac,
                    }
                  : {
                      ninEncrypted: this.#crypto.encrypt(input.idNumber, current.id),
                      ninHmac: hmac,
                    }),
              }
            : { ...common, status, requestedTier: 2, rejectionReason: TIER2_REJECTION_REASON },
        });
        await this.#recordDecision(tx, current, {
          action: decision.approved ? 'kyc.approved' : 'kyc.rejected',
          actor: { type: 'USER', userId },
          status,
          tier: decision.approved ? 2 : current.tier,
          context,
          metadata: {
            tier: 2,
            idType: input.type,
            provider,
            ...(decision.approved
              ? { decidedBy: 'AUTOMATIC' }
              : {
                  decidedBy: 'AUTOMATIC',
                  cause: decision.cause,
                  ...(decision.mismatched === undefined ? {} : { mismatched: decision.mismatched }),
                }),
          },
        });
        return this.#overview(tx, { id: current.id });
      });
    } catch (err) {
      // Another account stored the same number between our check and our commit.
      if (decision.approved && isUniqueViolation(err)) {
        return this.#decideTier2(userId, expectedTier, input, hmac, context, {
          approved: false,
          cause: 'DUPLICATE_IDENTITY',
          providerReference: decision.providerReference,
        });
      }
      throw err;
    }
  }

  /** Sends the submission's documents to the provider and records its reference. */
  async #sendDocumentsToProvider(profileId: string): Promise<void> {
    const profile = await this.#db.kycProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: {
        user: { select: { firstName: true, lastName: true } },
        documents: { where: { status: 'PENDING' } },
      },
    });
    if (profile.dateOfBirth === null || profile.submittedAt === null) {
      throw new Error(`Profile ${profileId} has no Tier 3 submission`);
    }
    const documents = await Promise.all(
      profile.documents.map(async (d) => ({
        type: d.type,
        mimeType: d.mimeType,
        content: await this.#storage.get(d.storageKey),
      })),
    );
    const { providerReference } = await this.#provider.submitDocumentCheck({
      // Fixed per submission, so a retry reuses the provider's check instead of starting another.
      reference: `kyc:${profileId}:tier3:${String(profile.submittedAt.getTime())}`,
      subject: {
        firstName: profile.user.firstName,
        lastName: profile.user.lastName,
        dateOfBirth: profile.dateOfBirth.toISOString().slice(0, 10),
      },
      documents,
    });
    // Only onto the same, still-open submission.
    await this.#db.kycProfile.updateMany({
      where: {
        id: profileId,
        submittedAt: profile.submittedAt,
        status: { in: [...UNDER_REVIEW] },
        providerReference: null,
      },
      data: { providerReference },
    });
  }

  async #reviewCase(profileId: string): Promise<KycReviewCase> {
    const profile = await this.#db.kycProfile.findUniqueOrThrow({ where: { id: profileId } });
    return {
      profileId,
      userId: profile.userId,
      kyc: await this.#overview(this.#db, { id: profileId }),
      providerCheck:
        profile.providerReference === null
          ? null
          : await this.#provider.getDocumentCheck(profile.providerReference),
    };
  }

  /**
   * Row lock on the profile: every KYC decision, and a name change (FOR SHARE in users),
   * serialises on it, so two requests can't both act on the same state.
   */
  async #lockProfile(
    tx: Prisma.TransactionClient,
    where: { userId: string } | { id: string },
  ): Promise<KycProfile> {
    if ('userId' in where) {
      await tx.$queryRaw`SELECT id FROM kyc_profiles WHERE user_id = ${where.userId}::uuid FOR UPDATE`;
    } else {
      await tx.$queryRaw`SELECT id FROM kyc_profiles WHERE id = ${where.id}::uuid FOR UPDATE`;
    }
    return tx.kycProfile.findUniqueOrThrow({ where });
  }

  /** The user-facing view, with the D3 limits for the current and next tier. */
  async #overview(
    db: Pick<PrismaClient, 'kycProfile' | 'tierLimit'>,
    where: { userId: string } | { id: string },
  ): Promise<KycOverview> {
    const profile = await db.kycProfile.findUniqueOrThrow({
      where,
      include: PROFILE_WITH_DOCUMENTS,
    });
    return toKycOverview(profile, {
      current: await tierLimitsView(db, profile.tier),
      next: await tierLimitsView(db, profile.tier + 1),
    });
  }

  /** Audit row + `kyc.status_changed` outbox event, in the decision's transaction. */
  async #recordDecision(
    tx: Prisma.TransactionClient,
    profile: KycProfile,
    entry: {
      action: 'kyc.approved' | 'kyc.rejected' | 'kyc.submitted' | 'kyc.review_started';
      actor: AuditActor;
      status: 'APPROVED' | 'REJECTED' | 'PENDING' | 'IN_REVIEW';
      tier: number;
      context: AuditContext;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await recordAudit(tx, {
      action: entry.action,
      actor: entry.actor,
      resource: { type: 'kyc_profile', id: profile.id },
      context: entry.context,
      metadata: { ...entry.metadata, from: profile.status, to: entry.status },
    });
    await writeOutboxEvent(tx, {
      type: 'kyc.status_changed',
      aggregate: { type: 'user', id: profile.userId },
      payload: { userId: profile.userId, status: entry.status, tier: entry.tier },
    });
  }
}

/** Separation of duties: nobody decides their own KYC, whatever their role. */
function assertNotSelfReview(profile: Pick<KycProfile, 'userId'>, reviewerId: string): void {
  if (profile.userId === reviewerId) {
    throw new ForbiddenError("You can't review your own verification.", {
      code: ErrorCode.KYC_SELF_REVIEW,
    });
  }
}
