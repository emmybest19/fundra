// MockKycProvider: a deterministic stand-in for a real KYC provider, driven by reserved
// "magic" numbers like a payment sandbox. It approves almost everyone, so every decision it
// makes is recorded with provider `MOCK`.
import { randomUUID } from 'node:crypto';
import { matchIdentity } from './identity-match.ts';
import {
  KycProviderUnavailableError,
  type DocumentCheckRequest,
  type DocumentCheckResult,
  type IdentityNumberCheck,
  type IdentityNumberResult,
  type IdentitySubject,
  type KycProvider,
} from './kyc-provider.ts';

/** Reserved BVN/NIN values. Any other 11-digit number matches the subject. */
export const MOCK_IDENTITY_NUMBERS = {
  NOT_FOUND: '00000000001',
  NAME_MISMATCH: '00000000002',
  DATE_OF_BIRTH_MISMATCH: '00000000003',
  UNAVAILABLE: '00000000009',
} as const;

type DocumentOutcome = Exclude<DocumentCheckResult, { status: 'PENDING' }>;

interface DocumentCheck {
  /** Reads before the first lookup are PENDING, like a provider still working. */
  looked: boolean;
  outcome: DocumentOutcome;
}

export class MockKycProvider implements KycProvider {
  readonly name = 'MOCK' as const;
  /** Fundra reference → provider reference, so a repeated request reuses the same check. */
  readonly #references = new Map<string, string>();
  readonly #documentChecks = new Map<string, DocumentCheck>();
  readonly #forcedDocumentOutcomes = new Map<string, string>();

  verifyIdentityNumber(check: IdentityNumberCheck): Promise<IdentityNumberResult> {
    if (check.idNumber === MOCK_IDENTITY_NUMBERS.UNAVAILABLE) {
      return Promise.reject(new KycProviderUnavailableError(this.name));
    }
    const providerReference = this.#providerReference(check.reference);
    const record = this.#lookup(check.idNumber, check.subject);
    if (record === undefined) return Promise.resolve({ outcome: 'NOT_FOUND', providerReference });

    // Compare and discard, exactly as a real adapter must.
    const mismatched = matchIdentity(check.subject, record);
    return Promise.resolve(
      mismatched.length === 0
        ? { outcome: 'MATCH', providerReference }
        : { outcome: 'MISMATCH', providerReference, mismatched },
    );
  }

  submitDocumentCheck(request: DocumentCheckRequest): Promise<DocumentCheckResult> {
    const providerReference = this.#providerReference(request.reference);
    const existing = this.#documentChecks.get(providerReference);
    // A repeated submit reports the existing check instead of starting another.
    if (existing?.looked === true) return Promise.resolve(existing.outcome);
    if (existing === undefined) {
      const reason = this.#forcedDocumentOutcomes.get(request.reference);
      this.#documentChecks.set(providerReference, {
        looked: false,
        outcome:
          reason === undefined
            ? { providerReference, status: 'ACCEPTED' }
            : { providerReference, status: 'REJECTED', reason },
      });
    }
    return Promise.resolve({ providerReference, status: 'PENDING' });
  }

  getDocumentCheck(providerReference: string): Promise<DocumentCheckResult> {
    const check = this.#documentChecks.get(providerReference);
    // A real provider answers 404 for a reference it never issued: a bug on our side.
    if (check === undefined) {
      return Promise.reject(new Error('Unknown document check reference'));
    }
    if (!check.looked) {
      check.looked = true;
      return Promise.resolve({ providerReference, status: 'PENDING' });
    }
    return Promise.resolve(check.outcome);
  }

  /** Test hook: the document check submitted under this Fundra reference will be rejected. */
  rejectDocumentsFor(reference: string, reason = 'Document is unreadable'): void {
    this.#forcedDocumentOutcomes.set(reference, reason);
  }

  #providerReference(reference: string): string {
    let providerReference = this.#references.get(reference);
    if (providerReference === undefined) {
      providerReference = `mock_${randomUUID()}`;
      this.#references.set(reference, providerReference);
    }
    return providerReference;
  }

  /** The "record" the provider holds: the subject, altered for the magic numbers. */
  #lookup(idNumber: string, subject: IdentitySubject): IdentitySubject | undefined {
    if (!/^\d{11}$/.test(idNumber) || idNumber === MOCK_IDENTITY_NUMBERS.NOT_FOUND) {
      return undefined;
    }
    if (idNumber === MOCK_IDENTITY_NUMBERS.NAME_MISMATCH) {
      return { ...subject, firstName: 'Mock', lastName: 'Person' };
    }
    if (idNumber === MOCK_IDENTITY_NUMBERS.DATE_OF_BIRTH_MISMATCH) {
      return { ...subject, dateOfBirth: '1900-01-01' };
    }
    return subject;
  }
}
