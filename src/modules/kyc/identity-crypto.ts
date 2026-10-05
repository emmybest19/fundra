// Protects BVN/NIN at rest: AES-256-GCM for the number itself (only KYC code can read it back)
// and an HMAC for uniqueness (the same number can't verify two accounts, and the lookup
// never needs the plain number in the database).
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { IdentityNumberType } from './providers/kyc-provider.ts';

/** Leading byte of every ciphertext, so a future key or algorithm change can coexist. */
const FORMAT_V1 = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class IdentityNumberCrypto {
  readonly #encryptionKey: Buffer;
  readonly #hmacKey: string;

  /** `encryptionKey`: 32 bytes, base64 (env KYC_ENCRYPTION_KEY). */
  constructor(encryptionKey: string, hmacKey: string) {
    this.#encryptionKey = Buffer.from(encryptionKey, 'base64');
    if (this.#encryptionKey.length !== 32) throw new Error('KYC encryption key must be 32 bytes');
    this.#hmacKey = hmacKey;
  }

  /**
   * `version ‖ nonce ‖ tag ‖ ciphertext`. The profile ID is bound in as authenticated data,
   * so a ciphertext copied onto another profile fails to decrypt.
   */
  encrypt(idNumber: string, profileId: string): Uint8Array<ArrayBuffer> {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#encryptionKey, nonce);
    cipher.setAAD(Buffer.from(profileId));
    const ciphertext = Buffer.concat([cipher.update(idNumber, 'utf8'), cipher.final()]);
    return new Uint8Array(
      Buffer.concat([Buffer.of(FORMAT_V1), nonce, cipher.getAuthTag(), ciphertext]),
    );
  }

  /** Throws if the data was tampered with, belongs to another profile or used another key. */
  decrypt(data: Uint8Array, profileId: string): string {
    const bytes = Buffer.from(data);
    if (bytes[0] !== FORMAT_V1 || bytes.length <= 1 + NONCE_BYTES + TAG_BYTES) {
      throw new Error('Unrecognised identity-number ciphertext');
    }
    const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
    const tag = bytes.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.#encryptionKey, nonce);
    decipher.setAAD(Buffer.from(profileId));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(bytes.subarray(1 + NONCE_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  }

  /** 64 hex characters (`bvn_hmac` / `nin_hmac`). The type is mixed in so a BVN and a NIN never collide. */
  hmac(type: IdentityNumberType, idNumber: string): string {
    return createHmac('sha256', this.#hmacKey).update(`${type}:${idNumber}`).digest('hex');
  }
}
