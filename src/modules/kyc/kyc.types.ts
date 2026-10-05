// Types for kyc: what each tier needs, and the overview returned to the user.
import type {
  KycDocument,
  KycDocumentType,
  KycProfile,
  KycStatus,
} from '../../generated/prisma/client.ts';
import type { IdentityNumberType } from './providers/kyc-provider.ts';

/** Any one of these proves identity for Tier 3. */
export const ID_DOCUMENT_TYPES: readonly KycDocumentType[] = [
  'NATIONAL_ID',
  'PASSPORT',
  'DRIVERS_LICENSE',
  'VOTERS_CARD',
];

/** Tier 3 needs one ID document and a utility bill (proof of address). */
export function missingTier3Documents(types: readonly KycDocumentType[]): string[] {
  const missing: string[] = [];
  if (!types.some((type) => ID_DOCUMENT_TYPES.includes(type))) {
    missing.push(`an ID document (${ID_DOCUMENT_TYPES.join(', ')})`);
  }
  if (!types.includes('UTILITY_BILL')) missing.push('a utility bill (UTILITY_BILL)');
  return missing;
}

const NEXT_TIER_REQUIRES: Record<1 | 2 | 3, readonly string[]> = {
  1: ['dateOfBirth'],
  2: ['bvnOrNin'],
  3: ['idDocument', 'utilityBill', 'address'],
};

export interface KycDocumentView {
  id: string;
  type: KycDocumentType;
  mimeType: string;
  sizeBytes: number;
  status: KycDocument['status'];
  uploadedAt: Date;
}

export interface KycOverview {
  tier: number;
  status: KycStatus;
  requestedTier: number | null;
  rejectionReason: string | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  /** Which number is on file, never the number itself, not even masked. */
  identityNumber: { type: IdentityNumberType } | null;
  address: {
    line1: string;
    line2: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    postalCode: string | null;
  } | null;
  documents: KycDocumentView[];
  /** The tier the user can apply for next and what it needs; null at Tier 3. */
  next: { tier: number; requires: readonly string[] } | null;
}

export const toDocumentView = (document: KycDocument): KycDocumentView => ({
  id: document.id,
  type: document.type,
  mimeType: document.mimeType,
  sizeBytes: document.sizeBytes,
  status: document.status,
  uploadedAt: document.uploadedAt,
});

export function toKycOverview(profile: KycProfile & { documents: KycDocument[] }): KycOverview {
  const nextTier = profile.tier + 1;
  return {
    tier: profile.tier,
    status: profile.status,
    requestedTier: profile.requestedTier,
    rejectionReason: profile.rejectionReason,
    submittedAt: profile.submittedAt,
    reviewedAt: profile.reviewedAt,
    identityNumber:
      profile.bvnHmac !== null
        ? { type: 'BVN' }
        : profile.ninHmac !== null
          ? { type: 'NIN' }
          : null,
    address:
      profile.addressLine1 === null
        ? null
        : {
            line1: profile.addressLine1,
            line2: profile.addressLine2,
            city: profile.city,
            state: profile.state,
            country: profile.country,
            postalCode: profile.postalCode,
          },
    documents: profile.documents.map(toDocumentView),
    next:
      nextTier === 1 || nextTier === 2 || nextTier === 3
        ? { tier: nextTier, requires: NEXT_TIER_REQUIRES[nextTier] }
        : null,
  };
}
