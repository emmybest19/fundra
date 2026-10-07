import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../../../src/common/types/api.ts';
import { NotFoundError } from '../../../src/common/errors/index.ts';
import { createLogger } from '../../../src/config/logger.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';
import {
  canWalletTransition,
  WALLET_TRANSITIONS,
} from '../../../src/modules/wallets/wallet-status.ts';
import { createWalletRouter } from '../../../src/modules/wallets/wallet.routes.ts';
import type { WalletService } from '../../../src/modules/wallets/wallet.service.ts';
import { toWalletView } from '../../../src/modules/wallets/wallet.types.ts';

const WALLET_ID = '0199a0a0-0000-7000-8000-0000000000aa';

describe('wallet status lifecycle', () => {
  it('allows exactly the documented transitions', () => {
    expect(WALLET_TRANSITIONS).toEqual({
      ACTIVE: ['FROZEN', 'CLOSED'],
      FROZEN: ['ACTIVE', 'CLOSED'],
      CLOSED: ['ACTIVE'],
    });
  });

  it('never goes straight from CLOSED to FROZEN, and never "changes" to itself', () => {
    expect(canWalletTransition('CLOSED', 'FROZEN')).toBe(false);
    for (const status of ['ACTIVE', 'FROZEN', 'CLOSED'] as const) {
      expect(canWalletTransition(status, status), status).toBe(false);
    }
  });
});

describe('toWalletView', () => {
  const wallet = {
    id: WALLET_ID,
    userId: 'u-1',
    currency: 'NGN',
    accountNumber: '0123456789',
    ledgerAccountId: 'la-1',
    status: 'ACTIVE' as const,
    ledgerBalance: 1_500_000n,
    availableBalance: 1_200_000n,
    createdAt: new Date('2026-10-06T09:00:00Z'),
    updatedAt: new Date('2026-10-06T09:00:00Z'),
  };

  it('shows balances as kobo strings, with onHold = ledger − available', () => {
    expect(toWalletView(wallet).balance).toEqual({
      ledger: '1500000',
      available: '1200000',
      onHold: '300000',
    });
  });

  it('keeps internal fields out: no owner ID, ledger account or update time', () => {
    expect(Object.keys(toWalletView(wallet)).sort()).toEqual([
      'accountNumber',
      'balance',
      'createdAt',
      'currency',
      'id',
      'status',
    ]);
  });

  it('is exact beyond 2^53 kobo', () => {
    const huge = 2n ** 60n;
    expect(
      toWalletView({ ...wallet, ledgerBalance: huge, availableBalance: huge - 1n }).balance,
    ).toEqual({ ledger: huge.toString(), available: (huge - 1n).toString(), onHold: '1' });
  });
});

const fakeAuthenticate: RequestHandler = (req, res, next) => {
  const userId = req.get('x-test-user');
  if (userId === undefined) {
    res.status(401).json({ success: false });
    return;
  }
  req.auth = { userId, sessionId: 's-1', roles: ['USER'], status: 'ACTIVE' };
  next();
};

function setup() {
  const wallets = {
    list: vi.fn().mockResolvedValue([{ id: WALLET_ID }]),
    get: vi.fn().mockResolvedValue({ id: WALLET_ID }),
  };
  const app = express();
  app.use(createRequestLogger(createLogger({ level: 'silent', pretty: false })));
  app.use(
    '/wallets',
    createWalletRouter({
      wallets: wallets as unknown as WalletService,
      authenticate: fakeAuthenticate,
    }),
  );
  app.use(errorHandler);
  return { app, wallets };
}

describe('wallets router', () => {
  it('requires authentication', async () => {
    const { app } = setup();
    expect((await request(app).get('/wallets')).status).toBe(401);
    expect((await request(app).get(`/wallets/${WALLET_ID}`)).status).toBe(401);
  });

  it('reads the signed-in user’s wallets, never cached', async () => {
    const { app, wallets } = setup();
    const res = await request(app).get('/wallets').set('X-Test-User', 'u-1');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(wallets.list).toHaveBeenCalledWith('u-1');
  });

  it('asks for one wallet as the signed-in user, never cached', async () => {
    const { app, wallets } = setup();
    const res = await request(app).get(`/wallets/${WALLET_ID}`).set('X-Test-User', 'u-1');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(wallets.get).toHaveBeenCalledWith('u-1', WALLET_ID);
  });

  it('answers 422 for a malformed ID, without asking the service', async () => {
    const { app, wallets } = setup();
    const res = await request(app).get('/wallets/not-a-uuid').set('X-Test-User', 'u-1');

    expect(res.status).toBe(422);
    expect(wallets.get).not.toHaveBeenCalled();
  });

  it('passes the service’s 404 through for a wallet that is missing or not yours', async () => {
    const { app, wallets } = setup();
    wallets.get.mockRejectedValueOnce(new NotFoundError('Wallet not found.'));
    const res = await request(app).get(`/wallets/${WALLET_ID}`).set('X-Test-User', 'u-1');

    expect(res.status).toBe(404);
    expect((res.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });
});
