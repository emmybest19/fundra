import { describe, expect, it } from 'vitest';
import {
  KycProviderUnavailableError,
  type IdentityNumberCheck,
} from '../../../src/modules/kyc/providers/kyc-provider.ts';
import {
  MOCK_IDENTITY_NUMBERS,
  MockKycProvider,
} from '../../../src/modules/kyc/providers/mock-kyc-provider.ts';

const subject = { firstName: 'Emma', lastName: 'Okafor', dateOfBirth: '1995-04-12' };

function check(idNumber: string, reference = 'kyc-attempt-1'): IdentityNumberCheck {
  return { type: 'BVN', idNumber, subject, reference };
}

describe('MockKycProvider.verifyIdentityNumber', () => {
  it('matches any ordinary 11-digit number', async () => {
    const result = await new MockKycProvider().verifyIdentityNumber(check('22212345678'));

    expect(result.outcome).toBe('MATCH');
    expect(result.providerReference).toMatch(/^mock_/);
  });

  it('answers NOT_FOUND for the reserved number and for malformed input', async () => {
    const provider = new MockKycProvider();

    expect(
      (await provider.verifyIdentityNumber(check(MOCK_IDENTITY_NUMBERS.NOT_FOUND))).outcome,
    ).toBe('NOT_FOUND');
    expect((await provider.verifyIdentityNumber(check('1234'))).outcome).toBe('NOT_FOUND');
  });

  it('reports which field mismatched for the reserved numbers', async () => {
    const provider = new MockKycProvider();

    expect(
      await provider.verifyIdentityNumber(check(MOCK_IDENTITY_NUMBERS.NAME_MISMATCH)),
    ).toMatchObject({ outcome: 'MISMATCH', mismatched: ['name'] });
    expect(
      await provider.verifyIdentityNumber(check(MOCK_IDENTITY_NUMBERS.DATE_OF_BIRTH_MISMATCH)),
    ).toMatchObject({ outcome: 'MISMATCH', mismatched: ['dateOfBirth'] });
  });

  it('throws KycProviderUnavailableError without the number in the message', async () => {
    const attempt = new MockKycProvider().verifyIdentityNumber(
      check(MOCK_IDENTITY_NUMBERS.UNAVAILABLE),
    );

    await expect(attempt).rejects.toBeInstanceOf(KycProviderUnavailableError);
    await expect(attempt).rejects.not.toThrow(MOCK_IDENTITY_NUMBERS.UNAVAILABLE);
  });

  it('returns only a verdict, never the record', async () => {
    const result = await new MockKycProvider().verifyIdentityNumber(check('22212345678'));

    expect(Object.keys(result).sort()).toEqual(['outcome', 'providerReference']);
  });

  it('reuses the provider reference for a repeated Fundra reference', async () => {
    const provider = new MockKycProvider();
    const first = await provider.verifyIdentityNumber(check('22212345678', 'a'));
    const again = await provider.verifyIdentityNumber(check('22212345678', 'a'));
    const other = await provider.verifyIdentityNumber(check('22212345678', 'b'));

    expect(again.providerReference).toBe(first.providerReference);
    expect(other.providerReference).not.toBe(first.providerReference);
  });
});

describe('MockKycProvider document checks', () => {
  const request = {
    reference: 'tier3-attempt-1',
    subject,
    documents: [
      { type: 'NATIONAL_ID' as const, mimeType: 'image/png', content: new Uint8Array([1, 2, 3]) },
    ],
  };

  it('is PENDING on submit and on the first lookup, then ACCEPTED', async () => {
    const provider = new MockKycProvider();
    const submitted = await provider.submitDocumentCheck(request);

    expect(submitted.status).toBe('PENDING');
    expect((await provider.getDocumentCheck(submitted.providerReference)).status).toBe('PENDING');
    expect(await provider.getDocumentCheck(submitted.providerReference)).toEqual({
      providerReference: submitted.providerReference,
      status: 'ACCEPTED',
    });
  });

  it('rejects with a reason when a test forces it', async () => {
    const provider = new MockKycProvider();
    provider.rejectDocumentsFor(request.reference, 'Photo is blurred');
    const { providerReference } = await provider.submitDocumentCheck(request);
    await provider.getDocumentCheck(providerReference);

    expect(await provider.getDocumentCheck(providerReference)).toEqual({
      providerReference,
      status: 'REJECTED',
      reason: 'Photo is blurred',
    });
  });

  it('does not restart a check when the same reference is submitted again', async () => {
    const provider = new MockKycProvider();
    const first = await provider.submitDocumentCheck(request);
    await provider.getDocumentCheck(first.providerReference);
    const again = await provider.submitDocumentCheck(request);

    expect(again).toEqual({ providerReference: first.providerReference, status: 'ACCEPTED' });
    expect((await provider.getDocumentCheck(first.providerReference)).status).toBe('ACCEPTED');
  });

  it('fails loudly for a reference it never issued', async () => {
    await expect(new MockKycProvider().getDocumentCheck('mock_unknown')).rejects.toThrow(
      'Unknown document check reference',
    );
  });
});
