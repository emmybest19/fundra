// What a KYC document upload may be: allowed types, size, and the check that the bytes really
// are what the Content-Type header claims.

/** Matches the `kyc_documents_mime_chk` constraint. */
export const KYC_DOCUMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type KycDocumentMimeType = (typeof KYC_DOCUMENT_MIME_TYPES)[number];

export const KYC_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

const SIGNATURES: readonly { mimeType: KycDocumentMimeType; bytes: readonly number[] }[] = [
  { mimeType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
];

/**
 * The type the file's first bytes say it is, or undefined if it's none of the allowed ones.
 * The Content-Type header is the client's claim; this is the evidence.
 */
export function detectDocumentType(bytes: Uint8Array): KycDocumentMimeType | undefined {
  return SIGNATURES.find(({ bytes: signature }) =>
    signature.every((byte, index) => bytes[index] === byte),
  )?.mimeType;
}

export function isDocumentMimeType(value: string): value is KycDocumentMimeType {
  return (KYC_DOCUMENT_MIME_TYPES as readonly string[]).includes(value);
}
