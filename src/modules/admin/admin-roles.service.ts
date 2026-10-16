// Role assignment (`roles:assign`, SUPER_ADMIN only). Roles are read from the database on
// every request, so a grant or revoke applies to the holder's very next call: no new token
// needed, and a revoked admin loses access at once.
import { isRoleName, ROLE_PERMISSIONS, type RoleName } from '../../common/constants/rbac.ts';
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../common/errors/index.ts';
import type { PrismaClient } from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditContext } from '../audit/audit.types.ts';

export class AdminRoleService {
  readonly #db: PrismaClient;

  constructor(db: PrismaClient) {
    this.#db = db;
  }

  /** Every role with what it grants (from code: the seed keeps the database in step). */
  async list() {
    const roles = await this.#db.role.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { users: true } } },
    });
    return roles
      .filter((role) => isRoleName(role.name))
      .map((role) => ({
        name: role.name,
        description: role.description,
        permissions: [...ROLE_PERMISSIONS[role.name as RoleName]],
        holders: role._count.users,
      }));
  }

  async grant(targetId: string, roleName: RoleName, adminId: string, context: AuditContext) {
    this.#assertStaffRole(roleName);
    if (targetId === adminId) throw selfAction();
    return this.#db.$transaction(async (tx) => {
      const target = await tx.user.findUnique({
        where: { id: targetId },
        select: { status: true },
      });
      if (target === null) throw new NotFoundError('User not found.');
      if (target.status === 'DEACTIVATED') {
        throw new ConflictError("A deactivated account can't be given a role.", {
          code: ErrorCode.CONFLICT,
        });
      }
      const role = await tx.role.findUniqueOrThrow({ where: { name: roleName } });
      const existing = await tx.userRole.findUnique({
        where: { userId_roleId: { userId: targetId, roleId: role.id } },
      });
      if (existing !== null) {
        throw new ConflictError(`This user already has the ${roleName} role.`, {
          code: ErrorCode.CONFLICT,
        });
      }
      await tx.userRole.create({
        data: { userId: targetId, roleId: role.id, grantedByUserId: adminId },
      });
      await recordAudit(tx, {
        action: 'role.granted',
        actor: { type: 'ADMIN', userId: adminId },
        resource: { type: 'user', id: targetId },
        context,
        metadata: { role: roleName },
      });
      return this.#rolesOf(tx, targetId);
    });
  }

  async revoke(targetId: string, roleName: RoleName, adminId: string, context: AuditContext) {
    this.#assertStaffRole(roleName);
    if (targetId === adminId) throw selfAction();
    return this.#db.$transaction(async (tx) => {
      const role = await tx.role.findUniqueOrThrow({ where: { name: roleName } });
      // Holders of this role, locked: two revokes at once can't both pass the last-one check.
      const holders = await tx.$queryRaw<{ user_id: string }[]>`
        SELECT user_id FROM user_roles WHERE role_id = ${role.id}::uuid FOR UPDATE`;
      if (!holders.some((h) => h.user_id === targetId)) {
        throw new NotFoundError(`This user doesn't have the ${roleName} role.`);
      }
      if (roleName === 'SUPER_ADMIN' && holders.length === 1) {
        throw new ConflictError('The last super admin can’t be removed.', {
          code: ErrorCode.LAST_SUPER_ADMIN,
        });
      }
      await tx.userRole.delete({ where: { userId_roleId: { userId: targetId, roleId: role.id } } });
      await recordAudit(tx, {
        action: 'role.revoked',
        actor: { type: 'ADMIN', userId: adminId },
        resource: { type: 'user', id: targetId },
        context,
        metadata: { role: roleName },
      });
      return this.#rolesOf(tx, targetId);
    });
  }

  /** USER is every customer's base role: it is neither granted nor revoked here. */
  #assertStaffRole(role: RoleName): void {
    if (role === 'USER') {
      throw new UnprocessableError(
        'USER is every account’s base role; it can’t be granted or revoked.',
        {
          code: ErrorCode.UNPROCESSABLE,
        },
      );
    }
  }

  async #rolesOf(
    tx: Pick<PrismaClient, 'userRole'>,
    userId: string,
  ): Promise<{ userId: string; roles: string[] }> {
    const rows = await tx.userRole.findMany({
      where: { userId },
      include: { role: { select: { name: true } } },
    });
    return { userId, roles: rows.map((r) => r.role.name).sort() };
  }
}

const selfAction = () =>
  new ForbiddenError("You can't change your own roles.", { code: ErrorCode.ADMIN_SELF_ACTION });
