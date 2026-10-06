import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectDocumentType } from '../../../src/modules/kyc/document-file.ts';
import {
  LocalDocumentStorage,
  MemoryDocumentStorage,
} from '../../../src/modules/kyc/document-storage.ts';
import { IdentityNumberCrypto } from '../../../src/modules/kyc/identity-crypto.ts';
import { canKycTransition, KYC_TRANSITIONS } from '../../../src/modules/kyc/kyc-status.ts';
import { isAdult } from '../../../src/modules/kyc/kyc.service.ts';
import { missingTier3Documents, toKycOverview } from '../../../src/modules/kyc/kyc.types.ts';
import { isNameLocked } from '../../../src/modules/users/user.service.ts';

const KEY = Buffer.alloc(32, 9).toString('base64');
const crypto = new IdentityNumberCrypto(KEY, 'hmac-key-for-tests-at-least-32-characters');
const PROFILE = '0199a0a0-0000-7000-8000-000000000001';
const OTHER_PROFILE = '0199a0a0-0000-7000-8000-000000000002';

describe('IdentityNumberCrypto', () => {
  it('round-trips, and never stores the number in plain text', () => {
    const sealed = crypto.encrypt('22212345678', PROFILE);

    expect(Buffer.from(sealed).toString('latin1')).not.toContain('22212345678');
    expect(crypto.decrypt(sealed, PROFILE)).toBe('22212345678');
  });

  it('uses a fresh nonce, so the same number encrypts differently each time', () => {
    expect(Buffer.from(crypto.encrypt('22212345678', PROFILE))).not.toEqual(
      Buffer.from(crypto.encrypt('22212345678', PROFILE)),
    );
  });

  it('refuses a ciphertext moved onto another profile', () => {
    expect(() => crypto.decrypt(crypto.encrypt('22212345678', PROFILE), OTHER_PROFILE)).toThrow();
  });

  it('detects tampering', () => {
    const sealed = crypto.encrypt('22212345678', PROFILE);
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0x01;

    expect(() => crypto.decrypt(sealed, PROFILE)).toThrow();
  });

  it('refuses a ciphertext made with another key', () => {
    const other = new IdentityNumberCrypto(Buffer.alloc(32, 1).toString('base64'), 'x'.repeat(32));

    expect(() => crypto.decrypt(other.encrypt('22212345678', PROFILE), PROFILE)).toThrow();
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => new IdentityNumberCrypto(Buffer.alloc(16).toString('base64'), 'x')).toThrow();
  });

  it('hashes deterministically per type, so a BVN and a NIN never collide', () => {
    const bvn = crypto.hmac('BVN', '22212345678');

    expect(bvn).toMatch(/^[0-9a-f]{64}$/);
    expect(crypto.hmac('BVN', '22212345678')).toBe(bvn);
    expect(crypto.hmac('NIN', '22212345678')).not.toBe(bvn);
  });
});

describe('detectDocumentType', () => {
  it.each([
    ['image/jpeg', [0xff, 0xd8, 0xff, 0xe0, 0x00]],
    ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]],
    ['application/pdf', [...Buffer.from('%PDF-1.7\n')]],
  ])('recognises %s by its first bytes', (mimeType, bytes) => {
    expect(detectDocumentType(new Uint8Array(bytes))).toBe(mimeType);
  });

  it('recognises nothing else, whatever the client claims', () => {
    expect(
      detectDocumentType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeUndefined();
    expect(detectDocumentType(Buffer.from('MZ\x90\x00'))).toBeUndefined();
    expect(detectDocumentType(new Uint8Array([0xff, 0xd8]))).toBeUndefined();
  });
});

describe('LocalDocumentStorage', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });
  const key = `${PROFILE}/0199a0a0-0000-7000-8000-00000000000f`;

  it('stores, reads back and deletes a file under its key', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fundra-kyc-'));
    const storage = new LocalDocumentStorage(dir);
    await storage.put(key, new Uint8Array([1, 2, 3]));

    expect([...(await storage.get(key))]).toEqual([1, 2, 3]);
    await storage.delete(key);
    await storage.delete(key); // already gone: still fine
    expect(await readdir(join(dir, PROFILE))).toEqual([]);
  });

  it('never overwrites an existing document', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fundra-kyc-'));
    const storage = new LocalDocumentStorage(dir);
    await storage.put(key, new Uint8Array([1]));

    await expect(storage.put(key, new Uint8Array([2]))).rejects.toThrow();
    expect([...(await storage.get(key))]).toEqual([1]);
  });

  it('refuses keys that could reach outside its directory', async () => {
    const storage = new LocalDocumentStorage(tmpdir());

    for (const bad of ['../etc/passwd', `${PROFILE}/../../x`, '/abs/path', 'a/b']) {
      await expect(storage.put(bad, new Uint8Array([1])), bad).rejects.toThrow('Invalid');
    }
    await expect(new MemoryDocumentStorage().put('../x', new Uint8Array([1]))).rejects.toThrow();
  });
});

describe('KYC status lifecycle', () => {
  it('allows exactly the documented transitions', () => {
    expect(KYC_TRANSITIONS).toEqual({
      NOT_STARTED: ['APPROVED'],
      APPROVED: ['APPROVED', 'REJECTED', 'PENDING'],
      REJECTED: ['APPROVED', 'REJECTED', 'PENDING'],
      PENDING: ['IN_REVIEW'],
      IN_REVIEW: ['APPROVED', 'REJECTED'],
    });
  });

  it('never decides a queued case without a reviewer opening it', () => {
    expect(canKycTransition('PENDING', 'APPROVED')).toBe(false);
    expect(canKycTransition('PENDING', 'REJECTED')).toBe(false);
    expect(canKycTransition('NOT_STARTED', 'PENDING')).toBe(false);
  });
});

describe('isNameLocked (users)', () => {
  it('locks from the first approval, even after a later rejection', () => {
    expect(isNameLocked({ tier: 0, status: 'NOT_STARTED' })).toBe(false);
    expect(isNameLocked({ tier: 1, status: 'APPROVED' })).toBe(true);
    // The Stage 8 bug: rejected at Tier 2, still verified at Tier 1.
    expect(isNameLocked({ tier: 1, status: 'REJECTED' })).toBe(true);
    expect(isNameLocked({ tier: 2, status: 'PENDING' })).toBe(true);
  });
});

describe('isAdult', () => {
  // 2026-10-05 09:00 in Lagos.
  const now = Date.parse('2026-10-05T08:00:00Z');

  it('counts from the 18th birthday, by the Lagos calendar', () => {
    expect(isAdult('2008-10-05', now)).toBe(true);
    expect(isAdult('2008-10-06', now)).toBe(false);
    // 23:30 UTC on the 4th is already the 5th in Lagos.
    expect(isAdult('2008-10-05', Date.parse('2026-10-04T23:30:00Z'))).toBe(true);
    expect(isAdult('2008-10-05', Date.parse('2026-10-04T22:30:00Z'))).toBe(false);
  });

  it('treats a 29 February birthday as reached on 1 March', () => {
    expect(isAdult('2008-02-29', Date.parse('2026-02-28T12:00:00Z'))).toBe(false);
    expect(isAdult('2008-02-29', Date.parse('2026-03-01T12:00:00Z'))).toBe(true);
  });
});

describe('missingTier3Documents', () => {
  it('needs any one ID document plus a utility bill', () => {
    expect(missingTier3Documents(['PASSPORT', 'UTILITY_BILL'])).toEqual([]);
    expect(missingTier3Documents(['UTILITY_BILL', 'SELFIE'])).toHaveLength(1);
    expect(missingTier3Documents(['NATIONAL_ID'])).toEqual(['a utility bill (UTILITY_BILL)']);
    expect(missingTier3Documents([])).toHaveLength(2);
  });
});

describe('toKycOverview', () => {
  const NO_LIMITS = { current: null, next: null };
  const base = {
    id: PROFILE,
    userId: OTHER_PROFILE,
    tier: 2,
    status: 'APPROVED' as const,
    requestedTier: null,
    dateOfBirth: new Date('1995-04-12'),
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    country: null,
    postalCode: null,
    bvnEncrypted: new Uint8Array([1, 2, 3]),
    ninEncrypted: null,
    bvnHmac: 'a'.repeat(64),
    ninHmac: null,
    provider: 'MOCK',
    providerReference: 'mock_x',
    submittedAt: null,
    reviewedAt: null,
    reviewedByUserId: null,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    documents: [],
  };

  it('says which number is on file, never the number or its hash', () => {
    const overview = toKycOverview(base, NO_LIMITS);
    const json = JSON.stringify(overview);

    expect(overview.identityNumber).toEqual({ type: 'BVN' });
    expect(json).not.toContain('a'.repeat(64));
    expect(json).not.toMatch(/Encrypted|Hmac|provider/);
  });

  it('points at the next tier and what it needs, and nothing after Tier 3', () => {
    expect(toKycOverview(base, NO_LIMITS).next).toEqual({
      tier: 3,
      requires: ['idDocument', 'utilityBill', 'address'],
    });
    expect(toKycOverview({ ...base, tier: 3 }, NO_LIMITS).next).toBeNull();
  });
});
