import { BadRequestException, Injectable } from "@nestjs/common";
import { OrganizationRole } from "@prisma/client";
import { APP_ROLES, allPermissions, appRoles, defaultRolePermissions, editableRoles, isPermission, permissionModules, type Permission } from "@ai-qa/domain";
import { PrismaService } from "../database/prisma.service";
import { PermissionsService } from "../rbac/permissions.service";
import { recordAudit } from "../common/audit";
import type { AuthenticatedUser } from "../auth/auth.types";

// The domain enum and the Prisma enum describe the same DB column; fail fast if they ever drift.
if (appRoles.slice().sort().join() !== Object.values(OrganizationRole).sort().join()) throw new Error("APP_ROLES is out of sync with the Prisma OrganizationRole enum");

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService, private readonly permissions: PermissionsService) {}

  async list(user: AuthenticatedUser) {
    const roles = await Promise.all(appRoles.map(async (role) => ({
      role,
      locked: !editableRoles.includes(role),
      permissions: await this.permissions.forRole(user.organizationId, role),
      defaults: defaultRolePermissions[role]
    })));
    return { modules: permissionModules, roles };
  }

  async update(user: AuthenticatedUser, role: string, input: unknown[]) {
    const target = this.editableRole(role);
    const next = [...new Set(input)];
    const unknown = next.find((permission) => !isPermission(permission));
    if (unknown !== undefined) throw new BadRequestException(`Unknown permission: ${String(unknown)}`);
    // A module action only makes sense if the module can be opened.
    const permissions = (next as Permission[]).filter((permission) => next.includes(`${permission.split(":")[0]}:view`));
    await this.prisma.rolePermission.upsert({
      where: { organizationId_role: { organizationId: user.organizationId, role: target } },
      create: { organizationId: user.organizationId, role: target, permissions },
      update: { permissions }
    });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "roles.permissions_updated", targetType: "Role", targetId: target, metadata: { permissions } });
    return { role: target, permissions: allPermissions.filter((permission) => permissions.includes(permission)) };
  }

  async reset(user: AuthenticatedUser, role: string) {
    const target = this.editableRole(role);
    await this.prisma.rolePermission.deleteMany({ where: { organizationId: user.organizationId, role: target } });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "roles.permissions_reset", targetType: "Role", targetId: target });
    return { role: target, permissions: defaultRolePermissions[target] };
  }

  private editableRole(role: string) {
    if (!editableRoles.includes(role as APP_ROLES)) throw new BadRequestException(`Only ${editableRoles.join(" and ")} permissions can be edited; ADMIN always has full access`);
    return role as APP_ROLES;
  }
}
