// The OpenAPI 3.1 description of the API, built from the same Zod schemas the routes validate
// with (Zod 4's toJSONSchema, input side: what a client sends). A test checks that every
// mounted route is listed here, so the document can't silently fall behind the code.
import { z, type ZodType } from 'zod';
import { ErrorCode } from '../common/errors/error-codes.ts';
import { uuid } from '../common/validators/index.ts';
import { ADMIN_ROUTES } from '../modules/admin/admin.routes.ts';
import * as admin from '../modules/admin/admin.schema.ts';
import * as auth from '../modules/auth/auth.schema.ts';
import * as beneficiaries from '../modules/beneficiaries/beneficiary.schema.ts';
import * as kyc from '../modules/kyc/kyc.schema.ts';
import * as notifications from '../modules/notifications/notification.schema.ts';
import * as payments from '../modules/payments/payment.schema.ts';
import * as statements from '../modules/statements/statement.schema.ts';
import * as transactions from '../modules/transactions/transaction.schema.ts';
import * as transfers from '../modules/transfers/transfer.schema.ts';
import { preferencesPatch } from '../modules/users/preferences.ts';
import * as users from '../modules/users/user.schema.ts';
import { walletParams } from '../modules/wallets/wallet.schema.ts';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface Operation {
  method: Method;
  /** Express style, relative to the API root, e.g. `/users/me` or `/wallets/:id`. */
  path: string;
  tag: string;
  summary: string;
  /** `bearer`: an access token; `signature`: the payment provider's webhook signature. */
  auth: 'none' | 'bearer' | 'signature';
  /** Needs a verified account (email and phone). */
  verified?: boolean;
  /** Admin routes: the one permission required. */
  permission?: string;
  idempotent?: boolean;
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  /** A raw (non-JSON) body, e.g. a KYC document upload. */
  rawBody?: string;
  status?: number;
  errors?: string[];
}

const idParams = z.strictObject({ id: uuid });

const P = (
  method: Method,
  path: string,
  tag: string,
  summary: string,
  extra: Partial<Operation> = {},
): Operation => ({ method, path, tag, summary, auth: 'bearer', ...extra });

/** Admin operations come from the router's own table, so their permissions can't drift. */
const ADMIN_INPUTS: Record<string, Partial<Operation>> = {
  listUsers: { query: admin.usersQuery },
  getUser: { params: admin.idParams },
  suspendUser: { params: admin.idParams, body: admin.reasonBody },
  reactivateUser: { params: admin.idParams, body: admin.reasonBody },
  kycQueue: { query: admin.kycQueueQuery },
  getKyc: { params: admin.idParams },
  startKycReview: { params: admin.idParams },
  approveKyc: { params: admin.idParams },
  rejectKyc: { params: admin.idParams, body: admin.reasonBody },
  listTransactions: { query: admin.transactionsQuery },
  getTransaction: { params: admin.idParams },
  reverseTransaction: { params: admin.idParams, body: admin.reasonBody },
  getWallet: { params: admin.idParams },
  freezeWallet: { params: admin.idParams, body: admin.reasonBody },
  unfreezeWallet: { params: admin.idParams, body: admin.reasonBody },
  reopenWallet: { params: admin.idParams },
  reconcile: {},
  listWebhooks: { query: admin.webhooksQuery },
  listAuditLogs: { query: admin.auditQuery },
  listRoles: {},
  grantRole: { params: admin.idParams, body: admin.roleBody },
  revokeRole: { params: admin.roleParams },
  getSettings: {},
  updateTierLimit: { params: admin.tierLimitParams, body: admin.tierLimitBody },
  updateFeeRule: { params: admin.feeRuleParams, body: admin.feeRuleBody },
};

/** `listUsers` → `List users`. */
const humanise = (handler: string) => {
  const words = handler.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const OPERATIONS: readonly Operation[] = [
  // Health (no auth, not under /api/v1)
  P('get', '/health/live', 'Health', 'Liveness: the process is up', { auth: 'none' }),
  P(
    'get',
    '/health/ready',
    'Health',
    'Readiness: dependencies reachable (503 while draining or down)',
    { auth: 'none' },
  ),

  // Auth
  P('post', '/api/v1/auth/register', 'Auth', 'Create an account', {
    auth: 'none',
    body: auth.registerBody,
    status: 201,
    errors: [ErrorCode.ACCOUNT_EXISTS, ErrorCode.HANDLE_TAKEN],
  }),
  P('post', '/api/v1/auth/login', 'Auth', 'Sign in: access token + refresh token', {
    auth: 'none',
    body: auth.loginBody,
    errors: [ErrorCode.INVALID_CREDENTIALS, ErrorCode.ACCOUNT_LOCKED, ErrorCode.ACCOUNT_DISABLED],
  }),
  P('post', '/api/v1/auth/refresh', 'Auth', 'Rotate the refresh token', {
    auth: 'none',
    body: auth.refreshTokenBody,
    errors: [ErrorCode.INVALID_REFRESH_TOKEN, ErrorCode.REFRESH_TOKEN_REUSED],
  }),
  P('post', '/api/v1/auth/logout', 'Auth', 'End this session', {
    auth: 'none',
    body: auth.refreshTokenBody,
  }),
  P('post', '/api/v1/auth/password/forgot', 'Auth', 'Send a password reset code', {
    auth: 'none',
    body: auth.forgotPasswordBody,
    status: 202,
  }),
  P('post', '/api/v1/auth/password/reset', 'Auth', 'Reset the password with the code', {
    auth: 'none',
    body: auth.resetPasswordBody,
    errors: [ErrorCode.INVALID_OTP],
  }),
  P('post', '/api/v1/auth/verify/email/request', 'Auth', 'Send an email verification code', {
    status: 202,
    errors: [ErrorCode.OTP_COOLDOWN, ErrorCode.ALREADY_VERIFIED],
  }),
  P('post', '/api/v1/auth/verify/email/confirm', 'Auth', 'Confirm the email code', {
    body: auth.confirmCodeBody,
    errors: [ErrorCode.INVALID_OTP],
  }),
  P('post', '/api/v1/auth/verify/phone/request', 'Auth', 'Send a phone verification code', {
    status: 202,
    errors: [ErrorCode.OTP_COOLDOWN, ErrorCode.ALREADY_VERIFIED],
  }),
  P('post', '/api/v1/auth/verify/phone/confirm', 'Auth', 'Confirm the phone code', {
    body: auth.confirmCodeBody,
    errors: [ErrorCode.INVALID_OTP],
  }),
  P('get', '/api/v1/auth/sessions', 'Auth', 'Signed-in devices'),
  P('delete', '/api/v1/auth/sessions', 'Auth', 'Sign out every other device'),
  P('delete', '/api/v1/auth/sessions/:id', 'Auth', 'Sign out one device', { params: idParams }),

  // Users
  P('get', '/api/v1/users/me', 'Users', 'Your profile'),
  P('patch', '/api/v1/users/me', 'Users', 'Update your profile', {
    body: users.updateProfileBody,
    errors: [ErrorCode.NAME_LOCKED, ErrorCode.HANDLE_TAKEN],
  }),
  P('get', '/api/v1/users/me/preferences', 'Users', 'Notification preferences'),
  P('patch', '/api/v1/users/me/preferences', 'Users', 'Change notification preferences', {
    body: preferencesPatch,
  }),
  P('post', '/api/v1/users/me/email', 'Users', 'Start an email change (sensitive)', {
    body: users.requestEmailChangeBody,
    status: 202,
    errors: [ErrorCode.INCORRECT_PASSWORD],
  }),
  P('post', '/api/v1/users/me/email/confirm', 'Users', 'Confirm the new email', {
    body: users.confirmEmailChangeBody,
    errors: [ErrorCode.INVALID_OTP, ErrorCode.CONTACT_UNAVAILABLE],
  }),
  P('post', '/api/v1/users/me/phone', 'Users', 'Start a phone change (sensitive)', {
    body: users.requestPhoneChangeBody,
    status: 202,
    errors: [ErrorCode.INCORRECT_PASSWORD],
  }),
  P('post', '/api/v1/users/me/phone/confirm', 'Users', 'Confirm the new phone', {
    body: users.confirmPhoneChangeBody,
    errors: [ErrorCode.INVALID_OTP, ErrorCode.CONTACT_UNAVAILABLE],
  }),
  P('post', '/api/v1/users/me/password', 'Users', 'Change password (sensitive)', {
    body: users.changePasswordBody,
    errors: [ErrorCode.INCORRECT_PASSWORD],
  }),
  P('post', '/api/v1/users/me/deactivate', 'Users', 'Close your account (sensitive)', {
    body: users.deactivateBody,
    errors: [ErrorCode.ACCOUNT_HAS_BALANCE, ErrorCode.ACCOUNT_HAS_PENDING_TRANSACTIONS],
  }),

  // KYC
  P('get', '/api/v1/kyc', 'KYC', 'Your verification status, limits and next step'),
  P('post', '/api/v1/kyc/tier-1', 'KYC', 'Tier 1: date of birth (creates your wallet)', {
    verified: true,
    body: kyc.tier1Body,
  }),
  P('post', '/api/v1/kyc/tier-2', 'KYC', 'Tier 2: BVN or NIN', {
    verified: true,
    body: kyc.tier2Body,
    errors: [ErrorCode.KYC_TIER_ORDER],
  }),
  P('put', '/api/v1/kyc/documents/:type', 'KYC', 'Upload a Tier 3 document (raw file body)', {
    verified: true,
    params: kyc.documentParams,
    rawBody: 'image/jpeg, image/png or application/pdf',
    errors: [ErrorCode.KYC_UNDER_REVIEW],
  }),
  P('post', '/api/v1/kyc/tier-3', 'KYC', 'Tier 3: submit documents and address for review', {
    verified: true,
    body: kyc.tier3Body,
    errors: [ErrorCode.KYC_UNDER_REVIEW],
  }),

  // Wallets and history
  P('get', '/api/v1/wallets', 'Wallets', 'Your wallets and balances'),
  P('get', '/api/v1/wallets/:id', 'Wallets', 'One wallet', { params: walletParams }),
  P('get', '/api/v1/transactions', 'Transactions', 'Your history (cursor-paged)', {
    query: transactions.historyQuery,
  }),
  P('get', '/api/v1/transactions/:id', 'Transactions', 'One transaction', {
    params: transactions.transactionParams,
  }),

  // Money movement
  P(
    'get',
    '/api/v1/transfers/recipient',
    'Transfers',
    'Who a handle or account number belongs to',
    { verified: true, query: transfers.recipientQuery, errors: [ErrorCode.RECIPIENT_NOT_FOUND] },
  ),
  P('post', '/api/v1/transfers', 'Transfers', 'Send money to a Fundra user', {
    verified: true,
    idempotent: true,
    body: transfers.createTransferBody,
    status: 201,
    errors: [
      ErrorCode.INSUFFICIENT_FUNDS,
      ErrorCode.LIMIT_PER_TRANSACTION_EXCEEDED,
      ErrorCode.LIMIT_DAILY_OUTFLOW_EXCEEDED,
      ErrorCode.RECIPIENT_NOT_FOUND,
      ErrorCode.RECIPIENT_CANNOT_RECEIVE,
      ErrorCode.SELF_TRANSFER,
      ErrorCode.KYC_REQUIRED,
    ],
  }),
  P('post', '/api/v1/payments/deposits', 'Payments', 'Start a deposit (returns a checkout URL)', {
    verified: true,
    idempotent: true,
    body: payments.createDepositBody,
    status: 201,
    errors: [ErrorCode.KYC_REQUIRED, ErrorCode.LIMIT_MAX_BALANCE_EXCEEDED, ErrorCode.WALLET_FROZEN],
  }),
  P('get', '/api/v1/payments/bank-accounts/resolve', 'Payments', 'Bank name enquiry', {
    verified: true,
    query: payments.bankAccountQuery,
    errors: [ErrorCode.BANK_ACCOUNT_NOT_FOUND],
  }),
  P('post', '/api/v1/payments/withdrawals', 'Payments', 'Withdraw to a bank account', {
    verified: true,
    idempotent: true,
    body: payments.createWithdrawalBody,
    status: 201,
    errors: [
      ErrorCode.BANK_ACCOUNT_NOT_FOUND,
      ErrorCode.INSUFFICIENT_FUNDS,
      ErrorCode.LIMIT_PER_TRANSACTION_EXCEEDED,
      ErrorCode.LIMIT_DAILY_OUTFLOW_EXCEEDED,
    ],
  }),
  P('get', '/api/v1/payments/billers', 'Payments', 'Billers you can pay', { verified: true }),
  P('post', '/api/v1/payments/bills', 'Payments', 'Pay a bill', {
    verified: true,
    idempotent: true,
    body: payments.createBillPaymentBody,
    status: 201,
    errors: [ErrorCode.BILLER_NOT_FOUND, ErrorCode.INSUFFICIENT_FUNDS],
  }),

  // Saved recipients, statements, notifications
  P('get', '/api/v1/beneficiaries', 'Beneficiaries', 'Your saved recipients', {
    query: beneficiaries.listBeneficiariesQuery,
  }),
  P('get', '/api/v1/beneficiaries/:id', 'Beneficiaries', 'One saved recipient', {
    params: beneficiaries.beneficiaryParams,
  }),
  P('post', '/api/v1/beneficiaries', 'Beneficiaries', 'Save a recipient', {
    verified: true,
    body: beneficiaries.createBeneficiaryBody,
    status: 201,
    errors: [
      ErrorCode.BENEFICIARY_EXISTS,
      ErrorCode.BENEFICIARY_SELF,
      ErrorCode.BENEFICIARY_LIMIT,
      ErrorCode.RECIPIENT_NOT_FOUND,
      ErrorCode.BANK_ACCOUNT_NOT_FOUND,
    ],
  }),
  P('patch', '/api/v1/beneficiaries/:id', 'Beneficiaries', 'Rename (nickname only)', {
    params: beneficiaries.beneficiaryParams,
    body: beneficiaries.updateBeneficiaryBody,
  }),
  P('delete', '/api/v1/beneficiaries/:id', 'Beneficiaries', 'Delete', {
    params: beneficiaries.beneficiaryParams,
    status: 204,
  }),
  P(
    'post',
    '/api/v1/statements',
    'Statements',
    'Request a statement (generated in the background)',
    { body: statements.requestStatementBody, status: 202 },
  ),
  P('get', '/api/v1/statements', 'Statements', 'Your statements', {
    query: statements.listStatementsQuery,
  }),
  P('get', '/api/v1/statements/:id', 'Statements', 'One statement', {
    params: statements.statementParams,
  }),
  P('get', '/api/v1/statements/:id/download', 'Statements', 'Download the CSV', {
    params: statements.statementParams,
    errors: [ErrorCode.STATEMENT_NOT_READY],
  }),
  P('get', '/api/v1/notifications', 'Notifications', 'Your in-app feed', {
    query: notifications.feedQuery,
  }),
  P('post', '/api/v1/notifications/read-all', 'Notifications', 'Mark everything read'),
  P('post', '/api/v1/notifications/:id/read', 'Notifications', 'Mark one read', {
    params: notifications.notificationParams,
    status: 204,
  }),

  // Webhooks
  P(
    'post',
    '/api/v1/webhooks/payments',
    'Webhooks',
    'Payment provider webhook (raw body, signed)',
    {
      auth: 'signature',
      rawBody: 'application/json (verified as raw bytes)',
      errors: [ErrorCode.INVALID_WEBHOOK_SIGNATURE],
    },
  ),

  // Admin (from ADMIN_ROUTES)
  ...ADMIN_ROUTES.map((route) =>
    P(route.method, `/api/v1/admin${route.path}`, 'Admin', humanise(route.handler), {
      verified: true,
      permission: route.permission,
      ...ADMIN_INPUTS[route.handler],
    }),
  ),
];

const toJson = (schema: ZodType) =>
  z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;

/** `/wallets/:id` → `/wallets/{id}`. */
const openApiPath = (path: string) => path.replace(/:([A-Za-z]+)/g, '{$1}');

function parameters(op: Operation) {
  const list: Record<string, unknown>[] = [];
  for (const [where, schema] of [
    ['path', op.params],
    ['query', op.query],
  ] as const) {
    if (schema === undefined) continue;
    const json = toJson(schema) as { properties?: Record<string, unknown>; required?: string[] };
    for (const [name, prop] of Object.entries(json.properties ?? {})) {
      list.push({
        name,
        in: where,
        required: where === 'path' || (json.required ?? []).includes(name),
        schema: prop,
      });
    }
  }
  if (op.idempotent === true) {
    list.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: { type: 'string', minLength: 8, maxLength: 255 },
      description: 'A new UUID per intended operation; reuse it only to retry that operation',
    });
  }
  return list;
}

export function buildOpenApiDocument(version: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const notes = [
      op.permission === undefined ? null : `Requires permission \`${op.permission}\`.`,
      op.verified === true ? 'Needs a verified account (email and phone).' : null,
      op.idempotent === true
        ? 'Idempotent: retry with the same `Idempotency-Key` to get the same answer.'
        : null,
      op.errors === undefined || op.errors.length === 0
        ? null
        : `Error codes: ${op.errors.map((e) => `\`${e}\``).join(', ')}.`,
    ].filter((n) => n !== null);
    const status = String(op.status ?? 200);
    (paths[openApiPath(op.path)] ??= {})[op.method] = {
      tags: [op.tag],
      summary: op.summary,
      ...(notes.length === 0 ? {} : { description: notes.join(' ') }),
      security:
        op.auth === 'bearer'
          ? [{ bearerAuth: [] }]
          : op.auth === 'signature'
            ? [{ webhookSignature: [] }]
            : [],
      parameters: parameters(op),
      ...(op.body !== undefined
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: toJson(op.body) } },
            },
          }
        : op.rawBody !== undefined
          ? {
              requestBody: {
                required: true,
                description: op.rawBody,
                content: {
                  'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
                },
              },
            }
          : {}),
      responses: {
        [status]:
          status === '204'
            ? { description: 'No content' }
            : {
                description: 'Success: `{ "data": … }`',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Success' } },
                },
              },
        default: {
          description: 'Error: `{ "error": { "code", "message", "details"? } }`',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Fundra API',
      version,
      description:
        'NGN digital wallet backend. Amounts are kobo as strings. See docs/api.md for behaviour and examples.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        webhookSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Mock-Signature',
          description: 'HMAC-SHA512 of the raw body (provider-specific header)',
        },
      },
      schemas: {
        Success: { type: 'object', required: ['data'], properties: { data: {}, meta: {} } },
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', enum: Object.values(ErrorCode) },
                message: { type: 'string' },
                details: { type: 'array', items: { type: 'object' } },
                requestId: { type: 'string' },
              },
            },
          },
        },
      },
    },
    paths,
  };
}
