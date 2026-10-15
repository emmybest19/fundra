import { describe, expect, it } from 'vitest';
import {
  PaymentProviderUnavailableError,
  type PayoutRequest,
} from '../../../src/modules/payments/providers/payment-provider.ts';
import {
  MOCK_ACCOUNT_NUMBERS,
  MOCK_BILLERS,
  MOCK_CUSTOMER_REFERENCES,
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from '../../../src/modules/payments/providers/mock-payment-provider.ts';

const webhookSecret = 'test-only-mock-payment-webhook-secret-0123';

function provider(): MockPaymentProvider {
  return new MockPaymentProvider({ webhookSecret });
}

const deposit = {
  reference: 'FND-TRX-20261014-a1b2c3',
  amount: 500_000n,
  currency: 'NGN' as const,
  email: 'ada@example.com',
};

function payout(accountNumber: string, reference = 'FND-TRX-20261014-d4e5f6'): PayoutRequest {
  return {
    reference,
    amount: 250_000n,
    currency: 'NGN',
    destination: { bankCode: '058', accountNumber, accountName: 'ADA OKAFOR' },
    narration: 'Fundra withdrawal',
  };
}

describe('MockPaymentProvider deposits', () => {
  it('opens a pending deposit with a checkout URL that cannot resolve', async () => {
    const mock = provider();
    const session = await mock.initializeDeposit(deposit);

    expect(session.providerReference).toMatch(/^mock_/);
    expect(new URL(session.checkoutUrl).hostname.endsWith('.invalid')).toBe(true);
    expect(await mock.getPaymentStatus(session.providerReference)).toEqual({
      providerReference: session.providerReference,
      reference: deposit.reference,
      status: 'PENDING',
      amount: 500_000n,
      currency: 'NGN',
    });
  });

  it('returns the same session for a retried reference, and refuses one reused for other money', async () => {
    const mock = provider();
    const first = await mock.initializeDeposit(deposit);

    expect(await mock.initializeDeposit(deposit)).toEqual(first);
    await expect(mock.initializeDeposit({ ...deposit, amount: 1n })).rejects.toThrow(
      /Duplicate reference/,
    );
  });

  it('refuses a non-positive amount', async () => {
    await expect(provider().initializeDeposit({ ...deposit, amount: 0n })).rejects.toThrow(
      /positive/,
    );
  });

  it('settles a deposit as succeeded by default, as a signed charge.success webhook', async () => {
    const mock = provider();
    const { providerReference } = await mock.initializeDeposit(deposit);
    const webhook = mock.settle(providerReference);

    expect(mock.verifyWebhook(webhook.rawBody, webhook.headers)).toBe(true);
    expect(mock.parseWebhook(webhook.rawBody)).toMatchObject({
      kind: 'DEPOSIT',
      outcome: 'SUCCEEDED',
      eventType: 'charge.success',
      providerReference,
      reference: deposit.reference,
      amount: 500_000n,
      currency: 'NGN',
    });
    expect((await mock.getPaymentStatus(providerReference))?.status).toBe('SUCCEEDED');
  });

  it('settles a deposit as failed when asked, with a reason', async () => {
    const mock = provider();
    const { providerReference } = await mock.initializeDeposit(deposit);
    const event = mock.parseWebhook(mock.settle(providerReference, { outcome: 'FAILED' }).rawBody);

    expect(event).toMatchObject({ kind: 'DEPOSIT', outcome: 'FAILED', eventType: 'charge.failed' });
    expect(event).toHaveProperty('reason', 'The card was declined');
  });

  it('can report an amount that disagrees with the payment', async () => {
    const mock = provider();
    const { providerReference } = await mock.initializeDeposit(deposit);
    const event = mock.parseWebhook(mock.settle(providerReference, { amount: 1n }).rawBody);

    expect(event).toHaveProperty('amount', 1n);
  });

  it('re-notifies a finished payment under a new event ID, but never flips its outcome', async () => {
    const mock = provider();
    const { providerReference } = await mock.initializeDeposit(deposit);
    const first = mock.parseWebhook(mock.settle(providerReference).rawBody);
    const again = mock.parseWebhook(mock.settle(providerReference).rawBody);

    expect(again?.eventId).not.toBe(first?.eventId);
    expect(() => mock.settle(providerReference, { outcome: 'FAILED' })).toThrow(
      /already SUCCEEDED/,
    );
  });

  it('throws for a reference it never issued', async () => {
    const mock = provider();

    expect(await mock.getPaymentStatus('mock_nope')).toBeNull();
    expect(() => mock.settle('mock_nope')).toThrow(/Unknown provider reference/);
  });
});

describe('MockPaymentProvider bank accounts and payouts', () => {
  it('resolves an ordinary account and refuses the reserved and malformed ones', async () => {
    const mock = provider();

    expect(await mock.resolveBankAccount({ bankCode: '058', accountNumber: '0123456789' })).toEqual(
      { bankCode: '058', accountNumber: '0123456789', accountName: 'MOCK ACCOUNT 6789' },
    );
    expect(
      await mock.resolveBankAccount({
        bankCode: '058',
        accountNumber: MOCK_ACCOUNT_NUMBERS.NOT_FOUND,
      }),
    ).toBeNull();
    expect(await mock.resolveBankAccount({ bankCode: '058', accountNumber: '12345' })).toBeNull();
    expect(
      await mock.resolveBankAccount({ bankCode: 'GTB', accountNumber: '0123456789' }),
    ).toBeNull();
  });

  it('accepts an ordinary payout as pending and settles it as succeeded', async () => {
    const mock = provider();
    const result = await mock.sendPayout(payout('0123456789'));

    expect(result.status).toBe('PENDING');
    expect(mock.parseWebhook(mock.settle(result.providerReference).rawBody)).toMatchObject({
      kind: 'PAYOUT',
      outcome: 'SUCCEEDED',
      eventType: 'transfer.success',
      amount: 250_000n,
    });
  });

  it('accepts a FAILS_LATER payout, then reports it failed', async () => {
    const mock = provider();
    const result = await mock.sendPayout(payout(MOCK_ACCOUNT_NUMBERS.FAILS_LATER));

    expect(result.status).toBe('PENDING');
    expect(mock.parseWebhook(mock.settle(result.providerReference).rawBody)).toMatchObject({
      kind: 'PAYOUT',
      outcome: 'FAILED',
      eventType: 'transfer.failed',
      reason: 'The beneficiary bank is offline',
    });
  });

  it('refuses a REJECTED payout on the spot, and says so again on a retry', async () => {
    const mock = provider();
    const request = payout(MOCK_ACCOUNT_NUMBERS.REJECTED);
    const result = await mock.sendPayout(request);

    expect(result).toMatchObject({
      status: 'FAILED',
      reason: 'The destination bank declined the transfer',
    });
    expect(await mock.sendPayout(request)).toEqual(result);
  });

  it('returns the same payout for a retried reference, so a timeout retry never pays twice', async () => {
    const mock = provider();
    const first = await mock.sendPayout(payout('0123456789'));

    expect(await mock.sendPayout(payout('0123456789'))).toEqual(first);
  });

  it('throws for a payout to an account that does not resolve', async () => {
    await expect(provider().sendPayout(payout(MOCK_ACCOUNT_NUMBERS.NOT_FOUND))).rejects.toThrow(
      /does not resolve/,
    );
  });
});

describe('MockPaymentProvider outages', () => {
  it('fails every API call while unavailable, without changing anything', async () => {
    const mock = provider();
    mock.setAvailable(false);

    await expect(mock.initializeDeposit(deposit)).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );
    await expect(
      mock.resolveBankAccount({ bankCode: '058', accountNumber: '0123456789' }),
    ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    await expect(mock.sendPayout(payout('0123456789'))).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );
    await expect(mock.getPaymentStatus('mock_x')).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );

    mock.setAvailable(true);
    const session = await mock.initializeDeposit(deposit);
    expect((await mock.getPaymentStatus(session.providerReference))?.status).toBe('PENDING');
  });
});

describe('MockPaymentProvider webhook verification', () => {
  async function signed() {
    const mock = provider();
    const { providerReference } = await mock.initializeDeposit(deposit);
    return { mock, webhook: mock.settle(providerReference) };
  }

  it('rejects a body changed by a single byte', async () => {
    const { mock, webhook } = await signed();
    const tampered = Buffer.from(webhook.rawBody.toString().replace('500000', '900000'));

    expect(mock.verifyWebhook(tampered, webhook.headers)).toBe(false);
  });

  it('rejects the same body re-serialized, since the signature covers the exact bytes', async () => {
    const { mock, webhook } = await signed();
    const reformatted = Buffer.from(
      JSON.stringify(JSON.parse(webhook.rawBody.toString()), null, 2),
    );

    expect(mock.verifyWebhook(reformatted, webhook.headers)).toBe(false);
  });

  it('rejects a webhook signed with another secret', async () => {
    const { mock, webhook } = await signed();
    const other = new MockPaymentProvider({ webhookSecret: `${webhookSecret}-other` });

    expect(other.verifyWebhook(webhook.rawBody, webhook.headers)).toBe(false);
    expect(mock.verifyWebhook(webhook.rawBody, webhook.headers)).toBe(true);
  });

  it('rejects a missing, malformed, repeated or upper-case signature header', async () => {
    const { mock, webhook } = await signed();
    const signature = String(webhook.headers[MOCK_SIGNATURE_HEADER]);
    const verify = (value: string | string[] | undefined) =>
      mock.verifyWebhook(webhook.rawBody, { [MOCK_SIGNATURE_HEADER]: value });

    expect(verify(undefined)).toBe(false);
    expect(verify('')).toBe(false);
    expect(verify(signature.slice(0, -2))).toBe(false);
    expect(verify(`${signature}00`)).toBe(false);
    expect(verify([signature, signature])).toBe(false);
    expect(verify(signature.toUpperCase())).toBe(false);
  });

  it('refuses a secret shorter than 32 characters', () => {
    expect(() => new MockPaymentProvider({ webhookSecret: 'short' })).toThrow(/32 characters/);
  });
});

describe('MockPaymentProvider.parseWebhook', () => {
  const mock = provider();
  const parse = (payload: unknown) => mock.parseWebhook(mock.signedWebhook(payload).rawBody);
  const data = {
    reference: 'FND-TRX-20261014-a1b2c3',
    provider_reference: 'mock_1',
    amount: '500000',
    currency: 'NGN',
  };

  it('returns OTHER for an event type Fundra does not act on', () => {
    expect(parse({ id: 'evt_1', event: 'customer.created' })).toEqual({
      kind: 'OTHER',
      eventId: 'evt_1',
      eventType: 'customer.created',
    });
  });

  it('returns null for bytes that are not JSON', () => {
    expect(mock.parseWebhook(Buffer.from('not json'))).toBeNull();
  });

  it.each([
    ['no event ID', { event: 'charge.success', data }],
    ['a known event without data', { id: 'evt_1', event: 'charge.success' }],
    [
      'a numeric amount',
      { id: 'evt_1', event: 'charge.success', data: { ...data, amount: 500000 } },
    ],
    ['a zero amount', { id: 'evt_1', event: 'charge.success', data: { ...data, amount: '0' } }],
    [
      'a negative amount',
      { id: 'evt_1', event: 'charge.success', data: { ...data, amount: '-5' } },
    ],
    [
      'a decimal amount',
      { id: 'evt_1', event: 'charge.success', data: { ...data, amount: '5.00' } },
    ],
    [
      'an unknown currency',
      { id: 'evt_1', event: 'charge.success', data: { ...data, currency: 'USD' } },
    ],
    [
      'no reference',
      { id: 'evt_1', event: 'charge.success', data: { ...data, reference: undefined } },
    ],
  ])('returns null for %s', (_label, payload) => {
    expect(parse(payload)).toBeNull();
  });

  it('keeps amounts beyond 2^53 exact', () => {
    expect(
      parse({
        id: 'evt_1',
        event: 'charge.success',
        data: { ...data, amount: '9007199254740993' },
      }),
    ).toHaveProperty('amount', 9_007_199_254_740_993n);
  });
});

describe('MockPaymentProvider bill payments and refunds', () => {
  const bill = (customerReference: string, reference = 'FND-TRX-20261015-b1b2b3') => ({
    reference,
    amount: 150_000n,
    currency: 'NGN' as const,
    billerCode: 'DSTV',
    customerReference,
  });

  it('lists billers whose patterns are valid regular expressions', async () => {
    const billers = await provider().listBillers();

    expect(billers.map((b) => b.code)).toEqual(['MTN_AIRTIME', 'DSTV', 'IKEDC_PREPAID']);
    for (const b of MOCK_BILLERS)
      expect(() => new RegExp(b.customerReferencePattern)).not.toThrow();
    expect(new RegExp(MOCK_BILLERS[0]?.customerReferencePattern ?? '').test('08031234567')).toBe(
      true,
    );
  });

  it('accepts a payment as pending and settles it as a signed bill.success', async () => {
    const mock = provider();
    const result = await mock.payBill(bill('1234567890'));

    expect(result.status).toBe('PENDING');
    expect(mock.parseWebhook(mock.settle(result.providerReference).rawBody)).toMatchObject({
      kind: 'BILL',
      outcome: 'SUCCEEDED',
      eventType: 'bill.success',
      amount: 150_000n,
    });
  });

  it('follows the reserved customer references: fails later, or refused on the spot', async () => {
    const mock = provider();
    const later = await mock.payBill(bill(MOCK_CUSTOMER_REFERENCES.FAILS_LATER, 'r1'));
    const refused = await mock.payBill(bill(MOCK_CUSTOMER_REFERENCES.REJECTED, 'r2'));

    expect(mock.parseWebhook(mock.settle(later.providerReference).rawBody)).toMatchObject({
      kind: 'BILL',
      outcome: 'FAILED',
      reason: 'The biller did not confirm the payment',
    });
    expect(refused).toMatchObject({ status: 'FAILED', reason: 'DStv could not be reached' });
  });

  it('throws for an unknown biller or a customer reference that does not fit it', async () => {
    const mock = provider();

    await expect(mock.payBill({ ...bill('1234567890'), billerCode: 'NOPE' })).rejects.toThrow();
    await expect(mock.payBill(bill('12'))).rejects.toThrow();
  });

  it('refunds a succeeded payment, in part then the rest, each with its own refund reference', async () => {
    const mock = provider();
    const { providerReference } = await mock.payBill(bill('1234567890'));
    mock.settle(providerReference);
    const part = mock.parseWebhook(mock.refund(providerReference, { amount: 50_000n }).rawBody);
    const rest = mock.parseWebhook(mock.refund(providerReference).rawBody);

    expect(part).toMatchObject({ kind: 'REFUND', eventType: 'refund.processed', amount: 50_000n });
    expect(rest).toMatchObject({ kind: 'REFUND', amount: 100_000n });
    expect(part).toHaveProperty('refundReference');
    expect(rest).not.toHaveProperty(
      'refundReference',
      (part as { refundReference: string }).refundReference,
    );
  });

  it('can report the same refund again under its reference', async () => {
    const mock = provider();
    const { providerReference } = await mock.payBill(bill('1234567890'));
    mock.settle(providerReference);
    const again = mock.parseWebhook(
      mock.refund(providerReference, { refundReference: 'rfd_same', amount: 1n }).rawBody,
    );

    expect(again).toMatchObject({ kind: 'REFUND', refundReference: 'rfd_same' });
  });

  it('refuses to refund a payment that has not succeeded, or a deposit', async () => {
    const mock = provider();
    const { providerReference } = await mock.payBill(bill('1234567890'));
    const deposited = await mock.initializeDeposit({
      reference: 'd1',
      amount: 1n,
      currency: 'NGN',
      email: 'a@b.c',
    });

    expect(() => mock.refund(providerReference)).toThrow(/not a succeeded bill payment/);
    mock.settle(deposited.providerReference);
    expect(() => mock.refund(deposited.providerReference)).toThrow(/not a succeeded bill payment/);
  });

  it('returns null for a refund event without its refund reference', () => {
    const mock = provider();
    const body = mock.signedWebhook({
      id: 'evt_1',
      event: 'refund.processed',
      data: { reference: 'r', provider_reference: 'p', amount: '1', currency: 'NGN' },
    }).rawBody;

    expect(mock.parseWebhook(body)).toBeNull();
  });
});
