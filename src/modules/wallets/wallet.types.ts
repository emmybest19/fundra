// Types for wallets: what the owner sees.
import type { Wallet, WalletStatus } from '../../generated/prisma/client.ts';

export interface WalletView {
  id: string;
  currency: string;
  /** Shown to the owner only, for receiving money. Senders use the recipient lookup (Stage 13). */
  accountNumber: string;
  /** Never the reason for a freeze: that stays in the audit log (no tipping off). */
  status: WalletStatus;
  /** Kobo strings (D1). `onHold` is reserved for money in flight, e.g. a pending withdrawal. */
  balance: { ledger: string; available: string; onHold: string };
  createdAt: Date;
}

export const toWalletView = (wallet: Wallet): WalletView => ({
  id: wallet.id,
  currency: wallet.currency,
  accountNumber: wallet.accountNumber,
  status: wallet.status,
  balance: {
    ledger: wallet.ledgerBalance.toString(),
    available: wallet.availableBalance.toString(),
    onHold: (wallet.ledgerBalance - wallet.availableBalance).toString(),
  },
  createdAt: wallet.createdAt,
});
