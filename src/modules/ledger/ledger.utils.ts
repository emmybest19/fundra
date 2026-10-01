// Ledger helpers: account codes (see docs/DATABASE.md, ledger_accounts.code).

export const walletAccountCode = (walletId: string): string => `WALLET:${walletId}`;

export const providerSettlementAccountCode = (providerCode: string, currency: string): string =>
  `PROVIDER_SETTLEMENT:${providerCode}:${currency}`;

export const feeRevenueAccountCode = (currency: string): string => `FEE_REVENUE:${currency}`;

export const suspenseAccountCode = (currency: string): string => `SUSPENSE:${currency}`;
