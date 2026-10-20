import { ForbiddenException, Injectable } from "@nestjs/common";
import { APP_ROLES, defaultRolePermissions, allPermissions, type Permission } from "@ai-qa/domain";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Permissions an organization grants a role: stored override, else the built-in default. ADMIN is always full. */
  async forRole(organizationId: string, role: APP_ROLES): Promise<Permission[]> {
    if (role === APP_ROLES.ADMIN) return allPermissions;
    const row = await this.prisma.rolePermission.findUnique({ where: { organizationId_role: { organizationId, role } } });
    return (row?.permissions as Permission[] | undefined) ?? defaultRolePermissions[role];
  }

  /** Resolves from the DB, not the JWT, so role and permission edits apply on the next request. */
  async forUser(user: AuthenticatedUser): Promise<{ role: APP_ROLES; permissions: Permission[] }> {
    const membership = await this.prisma.organizationMembership.findUnique({ where: { userId: user.userId } });
    if (!membership) throw new ForbiddenException("You do not belong to an organization");
    const role = membership.role as APP_ROLES;
    return { role, permissions: await this.forRole(membership.organizationId, role) };
  }

  async assert(user: AuthenticatedUser, ...required: Permission[]) {
    const { permissions } = await this.forUser(user);
    const missing = required.find((permission) => !permissions.includes(permission));
    if (missing) throw new ForbiddenException(`Your role is missing the "${missing}" permission`);
  }
}
