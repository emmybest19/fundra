// Seeds reference data. Run with `npm run db:seed`; safe to re-run.
//
// Code-defined data (roles, permissions, role mapping, payment providers, system ledger
// accounts) is synced on every run. Admin-tunable data (tier limits, fee rules) is only
// created when missing, so re-seeding never overwrites an admin's change.
import { CURRENCIES, toMinor, type Currency } from '../src/common/constants/currency.ts';
import {
  PERMISSIONS,
  ROLE_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  ROLES,
} from '../src/common/constants/rbac.ts';
import { disconnectDatabase, prisma } from '../src/config/database.ts';
import { logger } from '../src/config/logger.ts';
import type { LedgerAccountType, PrismaClient } from '../src/generated/prisma/client.ts';
import {
  feeRevenueAccountCode,
  providerSettlementAccountCode,
  suspenseAccountCode,
} from '../src/modules/ledger/ledger.utils.ts';

/** D3: tier limits per currency, in minor units. `maxBalance: null` means unlimited. */
export const TIER_LIMITS = CURRENCIES.flatMap((currency: Currency) => [
  {
    tier: 1,
    currency,
    perTransactionLimit: toMinor(50_000, currency),
    dailyOutflowLimit: toMinor(50_000, currency),
    maxBalance: toMinor(300_000, currency),
  },
  {
    tier: 2,
    currency,
    perTransactionLimit: toMinor(100_000, currency),
    dailyOutflowLimit: toMinor(200_000, currency),
    maxBalance: toMinor(500_000, currency),
  },
  {
    tier: 3,
    currency,
    perTransactionLimit: toMinor(5_000_000, currency),
    dailyOutflowLimit: toMinor(5_000_000, currency),
    maxBalance: null,
  },
]);

/** D6: initial fee schedule. P2P transfers are free. */
export const FEE_RULES = CURRENCIES.map((currency) => ({
  transactionType: 'TRANSFER' as const,
  currency,
  flatFee: 0n,
  percentageBps: 0,
}));

export const PAYMENT_PROVIDERS = [{ code: 'MOCK', name: 'Mock payment provider' }] as const;

export function systemLedgerAccounts(): {
  code: string;
  type: LedgerAccountType;
  currency: string;
}[] {
  return CURRENCIES.flatMap((currency) => [
    ...PAYMENT_PROVIDERS.map((provider) => ({
      code: providerSettlementAccountCode(provider.code, currency),
      type: 'ASSET' as const,
      currency,
    })),
    { code: feeRevenueAccountCode(currency), type: 'REVENUE' as const, currency },
    { code: suspenseAccountCode(currency), type: 'LIABILITY' as const, currency },
  ]);
}

export interface SeedSummary {
  permissions: number;
  roles: number;
  rolePermissions: number;
  tierLimitsCreated: number;
  feeRulesCreated: number;
  paymentProviders: number;
  systemLedgerAccounts: number;
}

/** Seeds everything in one database transaction: all of it applies, or none of it. */
export async function seed(client: PrismaClient): Promise<SeedSummary> {
  return client.$transaction(async (tx) => {
    const permissionIds = new Map<string, string>();
    for (const [key, description] of Object.entries(PERMISSIONS)) {
      const permission = await tx.permission.upsert({
        where: { key },
        create: { key, description },
        update: { description },
      });
      permissionIds.set(key, permission.id);
    }

    let rolePermissions = 0;
    for (const name of ROLES) {
      const role = await tx.role.upsert({
        where: { name },
        create: { name, description: ROLE_DESCRIPTIONS[name] },
        update: { description: ROLE_DESCRIPTIONS[name] },
      });
      const wanted = ROLE_PERMISSIONS[name].map((key) => {
        const id = permissionIds.get(key);
        if (id === undefined) throw new Error(`Unknown permission ${key} for role ${name}`);
        return id;
      });
      // Sync to exactly the code-defined set: grant missing, revoke removed.
      await tx.rolePermission.deleteMany({
        where: { roleId: role.id, permissionId: { notIn: wanted } },
      });
      await tx.rolePermission.createMany({
        data: wanted.map((permissionId) => ({ roleId: role.id, permissionId })),
        skipDuplicates: true,
      });
      rolePermissions += wanted.length;
    }

    const { count: tierLimitsCreated } = await tx.tierLimit.createMany({
      data: TIER_LIMITS,
      skipDuplicates: true,
    });

    let feeRulesCreated = 0;
    for (const rule of FEE_RULES) {
      const active = await tx.feeRule.findFirst({
        where: { transactionType: rule.transactionType, currency: rule.currency, isActive: true },
      });
      if (active === null) {
        await tx.feeRule.create({ data: rule });
        feeRulesCreated++;
      }
    }

    for (const provider of PAYMENT_PROVIDERS) {
      await tx.paymentProvider.upsert({
        where: { code: provider.code },
        create: provider,
        update: { name: provider.name },
      });
    }

    const accounts = systemLedgerAccounts();
    for (const account of accounts) {
      const existing = await tx.ledgerAccount.findUnique({ where: { code: account.code } });
      if (existing === null) {
        await tx.ledgerAccount.create({ data: account });
      } else if (existing.type !== account.type || existing.currency !== account.currency) {
        // Never "fix" a ledger account that may already carry entries.
        throw new Error(
          `Ledger account ${account.code} exists as ${existing.type}/${existing.currency}, ` +
            `expected ${account.type}/${account.currency}. Resolve manually.`,
        );
      }
    }

    return {
      permissions: permissionIds.size,
      roles: ROLES.length,
      rolePermissions,
      tierLimitsCreated,
      feeRulesCreated,
      paymentProviders: PAYMENT_PROVIDERS.length,
      systemLedgerAccounts: accounts.length,
    };
  });
}

if (import.meta.main) {
  try {
    const summary = await seed(prisma);
    logger.info(summary, 'seed complete');
  } finally {
    await disconnectDatabase();
  }
}
