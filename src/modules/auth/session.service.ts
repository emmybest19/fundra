// A user's sessions (signed-in devices): listing and remote sign-out.
import { NotFoundError } from '../../common/errors/index.ts';
import type { PrismaClient } from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditContext } from '../audit/audit.types.ts';

export interface SessionView {
  id: string;
  current: boolean;
  deviceId: string | null;
  deviceName: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export class SessionService {
  readonly #db: PrismaClient;
  readonly #now: () => number;

  constructor(db: PrismaClient, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** Active (not revoked, not expired) sessions, most recently used first. */
  async list(userId: string, currentSessionId: string): Promise<SessionView[]> {
    const sessions = await this.#db.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date(this.#now()) } },
      orderBy: { lastUsedAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      current: s.id === currentSessionId,
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
    }));
  }

  /**
   * Signs out one of the caller's sessions. Another user's session, or one already ended,
   * is a 404: existence of other people's sessions is never revealed.
   */
  async revoke(userId: string, sessionId: string, context: AuditContext): Promise<void> {
    await this.#db.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date(this.#now()), revokeReason: 'USER_REVOKED' },
      });
      if (count === 0) throw new NotFoundError('Session not found.');
      await recordAudit(tx, {
        action: 'auth.session_revoked',
        actor: { type: 'USER', userId },
        resource: { type: 'session', id: sessionId },
        context,
      });
    });
  }

  /** "Sign out everywhere else": revokes every active session except the current one. */
  async revokeOthers(
    userId: string,
    currentSessionId: string,
    context: AuditContext,
  ): Promise<number> {
    return this.#db.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: { userId, revokedAt: null, id: { not: currentSessionId } },
        data: { revokedAt: new Date(this.#now()), revokeReason: 'USER_REVOKED' },
      });
      if (count > 0) {
        await recordAudit(tx, {
          action: 'auth.session_revoked',
          actor: { type: 'USER', userId },
          resource: { type: 'user', id: userId },
          context,
          metadata: { scope: 'all_other_sessions', revoked: count },
        });
      }
      return count;
    });
  }
}
