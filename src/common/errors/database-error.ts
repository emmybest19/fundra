// Classifies database failures by their real PostgreSQL SQLSTATE.
//
// Prisma 7's error codes depend on the API used, not on what failed: the same CHECK violation
// is P2039 from a model call and P2010 from raw SQL, and a failure at COMMIT (the deferred
// balanced-ledger trigger) arrives as a bare DriverAdapterError with no code at all. The
// SQLSTATE survives in every case, so that's what we read (docs/DATABASE.md §8).

export type DatabaseFailureKind =
  | 'UNIQUE'
  | 'FOREIGN_KEY'
  | 'NOT_NULL'
  | 'CHECK'
  | 'APPEND_ONLY'
  | 'UNBALANCED_LEDGER'
  | 'RETRYABLE';

export interface DatabaseFailure {
  kind: DatabaseFailureKind;
  /** The PostgreSQL SQLSTATE, or the Prisma code when there is none (transaction timeout). */
  sqlstate: string;
  constraint?: string;
  /** Integrity rules the database enforces on its own (append-only, balanced books). */
  integrity: boolean;
}

/** Fundra-reserved SQLSTATEs, raised by our triggers. */
export const FUNDRA_SQLSTATE = {
  APPEND_ONLY: 'FN001',
  UNBALANCED_LEDGER: 'FN002',
} as const;

const BY_SQLSTATE: Readonly<Record<string, DatabaseFailureKind>> = {
  '23505': 'UNIQUE',
  '23503': 'FOREIGN_KEY',
  '23502': 'NOT_NULL',
  '23514': 'CHECK',
  [FUNDRA_SQLSTATE.APPEND_ONLY]: 'APPEND_ONLY',
  [FUNDRA_SQLSTATE.UNBALANCED_LEDGER]: 'UNBALANCED_LEDGER',
  '40001': 'RETRYABLE', // serialization_failure
  '40P01': 'RETRYABLE', // deadlock_detected
  '55P03': 'RETRYABLE', // lock_not_available
};

/** Interactive transaction expired (Prisma). Its work was rolled back, so a retry is safe. */
const PRISMA_TRANSACTION_TIMEOUT = 'P2028';

interface DriverCause {
  originalCode?: unknown;
  originalMessage?: unknown;
  constraint?: { index?: unknown };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The driver adapter's cause, wherever this error carries it. */
function driverCause(err: unknown): DriverCause | undefined {
  if (!isObject(err)) return undefined;
  // Prisma errors: meta.driverAdapterError.cause
  const meta = err.meta;
  if (
    isObject(meta) &&
    isObject(meta.driverAdapterError) &&
    isObject(meta.driverAdapterError.cause)
  ) {
    return meta.driverAdapterError.cause;
  }
  // Failures at COMMIT: a bare DriverAdapterError whose cause holds the code.
  if (err.name === 'DriverAdapterError' && isObject(err.cause)) return err.cause;
  return undefined;
}

/** Name of the violated constraint: given for unique and foreign keys, only in the message for CHECKs. */
function constraintOf(cause: DriverCause): string | undefined {
  if (typeof cause.constraint?.index === 'string') return cause.constraint.index;
  const message = typeof cause.originalMessage === 'string' ? cause.originalMessage : '';
  return /constraint "([^"]+)"/.exec(message)?.[1];
}

/** Null for anything that isn't a recognised database failure. */
export function classifyDatabaseError(err: unknown): DatabaseFailure | null {
  if (isObject(err) && err.code === PRISMA_TRANSACTION_TIMEOUT) {
    return { kind: 'RETRYABLE', sqlstate: PRISMA_TRANSACTION_TIMEOUT, integrity: false };
  }
  const cause = driverCause(err);
  if (cause === undefined || typeof cause.originalCode !== 'string') return null;
  const kind = BY_SQLSTATE[cause.originalCode];
  if (kind === undefined) return null;
  const constraint = constraintOf(cause);
  return {
    kind,
    sqlstate: cause.originalCode,
    ...(constraint === undefined ? {} : { constraint }),
    integrity: kind === 'APPEND_ONLY' || kind === 'UNBALANCED_LEDGER',
  };
}

/** A unique violation, optionally of one of the given constraints only. */
export function isUniqueViolation(err: unknown, ...constraints: string[]): boolean {
  const failure = classifyDatabaseError(err);
  if (failure?.kind !== 'UNIQUE') return false;
  return constraints.length === 0 || constraints.includes(failure.constraint ?? '');
}

/** Deadlock, serialization failure, lock timeout or expired transaction: safe to retry. */
export function isRetryable(err: unknown): boolean {
  return classifyDatabaseError(err)?.kind === 'RETRYABLE';
}
