// The KycProvider contract: how Fundra asks an outside service whether a person is who they
// say they are. The KYC service depends only on this; adapters (the mock now, a sandbox
// provider later) live next to it.
import type { KycDocumentType } from '../../../generated/prisma/client.ts';

export type KycProviderName = 'MOCK';

export type IdentityNumberType = 'BVN' | 'NIN';

/** The person as they described themselves to Fundra. */
export interface IdentitySubject {
  firstName: string;
  lastName: string;
  middleName?: string;
  /** `YYYY-MM-DD`. */
  dateOfBirth: string;
}

export interface IdentityNumberCheck {
  type: IdentityNumberType;
  /**
   * 11 digits, plain text, held in memory only. Named `idNumber` so the logger and audit
   * sanitizer redact it (SENSITIVE_KEYS).
   */
  idNumber: string;
  subject: IdentitySubject;
  /** Fundra's id for this attempt. Providers use it to avoid running the same check twice. */
  reference: string;
}

export type IdentityMismatch = 'name' | 'dateOfBirth';

/**
 * A verdict, never the provider's record. Adapters compare the record they receive with
 * `matchIdentity` and discard it, so Fundra never holds the provider's copy of a person.
 */
export type IdentityNumberResult =
  | { outcome: 'MATCH'; providerReference: string }
  | { outcome: 'MISMATCH'; providerReference: string; mismatched: readonly IdentityMismatch[] }
  | { outcome: 'NOT_FOUND'; providerReference: string };

export interface KycDocumentUpload {
  type: KycDocumentType;
  mimeType: string;
  content: Uint8Array;
}

export interface DocumentCheckRequest {
  reference: string;
  subject: IdentitySubject;
  documents: readonly KycDocumentUpload[];
}

/**
 * Document checks finish asynchronously at real providers: submit, then read the result
 * (later, also by webhook). For Tier 3 the result is input for the admin reviewer, not the
 * decision.
 */
export type DocumentCheckResult =
  | { providerReference: string; status: 'PENDING' | 'ACCEPTED' }
  | { providerReference: string; status: 'REJECTED'; reason: string };

export interface KycProvider {
  /** Stored in `kyc_profiles.provider` and audit metadata, so mock decisions stay visible. */
  readonly name: KycProviderName;
  verifyIdentityNumber(check: IdentityNumberCheck): Promise<IdentityNumberResult>;
  submitDocumentCheck(request: DocumentCheckRequest): Promise<DocumentCheckResult>;
  getDocumentCheck(providerReference: string): Promise<DocumentCheckResult>;
}

/**
 * The provider timed out, is down or answered with something unusable. The attempt stays
 * retryable; the service maps this to 503. Messages must never contain an identity number.
 */
export class KycProviderUnavailableError extends Error {
  constructor(provider: KycProviderName, options?: { cause?: unknown }) {
    super(`KYC provider ${provider} is unavailable`, options);
    this.name = 'KycProviderUnavailableError';
  }
}
