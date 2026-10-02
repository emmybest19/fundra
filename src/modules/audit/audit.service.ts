// Writes append-only audit records.
import type { Request } from 'express';
import { isSensitiveKey } from '../../common/constants/sensitive-keys.ts';
import type { Prisma } from '../../generated/prisma/client.ts';
import type { AuditContext, AuditEntry } from './audit.types.ts';

/** The Prisma client or an interactive-transaction client: both expose `auditLog`. */
export type AuditWriter = Pick<Prisma.TransactionClient, 'auditLog'>;

export const MAX_METADATA_BYTES = 8_192;
export const MAX_METADATA_DEPTH = 6;
export const MAX_USER_AGENT_LENGTH = 512;
const REDACTED = '[REDACTED]';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  // JSON can't hold bigint; amounts are stored as exact strings, like the API sends them.
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (seen.has(value)) return '[CIRCULAR]';
  if (depth >= MAX_METADATA_DEPTH) return '[MAX_DEPTH]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1, seen));
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(item, depth + 1, seen);
  }
  return out;
}

/**
 * Makes metadata safe to store forever (audit rows can't be edited or deleted): redacts
 * sensitive keys at any depth, converts bigint and Date, and caps circular references,
 * depth and size rather than failing the audited action.
 */
export function sanitizeMetadata(metadata: Record<string, unknown> = {}): Prisma.InputJsonObject {
  const clean = sanitizeValue(metadata, 0, new WeakSet()) as Prisma.InputJsonObject;
  const bytes = Buffer.byteLength(JSON.stringify(clean));
  return bytes > MAX_METADATA_BYTES ? { truncated: true, originalBytes: bytes } : clean;
}

/** Request-derived context: client IP (honours TRUST_PROXY_HOPS), user agent, request ID. */
export function auditContextFrom(req: Request): AuditContext {
  return {
    ip: req.ip,
    userAgent: req.get('user-agent')?.slice(0, MAX_USER_AGENT_LENGTH),
    requestId: typeof req.id === 'string' ? req.id : undefined,
  };
}

export function toAuditRow(entry: AuditEntry): Prisma.AuditLogUncheckedCreateInput {
  return {
    action: entry.action,
    actorType: entry.actor.type,
    actorUserId: entry.actor.type === 'SYSTEM' ? null : entry.actor.userId,
    resourceType: entry.resource?.type ?? null,
    resourceId: entry.resource?.id ?? null,
    ipAddress: entry.context?.ip ?? null,
    userAgent: entry.context?.userAgent ?? null,
    requestId: entry.context?.requestId ?? null,
    metadata: sanitizeMetadata(entry.metadata),
  };
}

/**
 * Records an audit entry. Pass the transaction client (`tx`) when auditing a change, so the
 * record commits or rolls back with it: an audited action without its audit row, or an audit
 * row for something that never happened, is impossible. Errors propagate on purpose.
 */
export async function recordAudit(db: AuditWriter, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({ data: toAuditRow(entry) });
}
