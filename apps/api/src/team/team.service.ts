import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { recordAudit } from "../common/audit";
import { APP_ROLES, appRoles } from "@ai-qa/domain";
import { PermissionsService } from "../rbac/permissions.service";

@Injectable()
export class TeamService {
  constructor(private readonly prisma: PrismaService, private readonly permissions: PermissionsService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.organizationMembership.findMany({
      where: { organizationId: user.organizationId },
      include: { user: { select: { id: true, email: true, displayName: true, createdAt: true } } },
      orderBy: { role: "asc" }
    }).then((memberships) => memberships.map((membership) => ({
      userId: membership.user.id,
      email: membership.user.email,
      displayName: membership.user.displayName,
      role: membership.role,
      joinedAt: membership.user.createdAt
    })));
  }

  async invite(user: AuthenticatedUser, input: { email: string; displayName: string; role: string; password?: string }) {
    const role = this.assertRole(input.role);
    await this.assertCanAssign(user, role);
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException("An account with this email already exists");
    const temporaryPassword = input.password && input.password.length >= 12 ? undefined : randomBytes(9).toString("base64url") + "!Aa";
    const passwordHash = await bcrypt.hash(temporaryPassword ?? input.password!, 12);
    const created = await this.prisma.user.create({
      data: {
        email,
        displayName: input.displayName.trim(),
        passwordHash,
        // The inviting admin vouches for the address; invited members aren't asked to confirm it.
        emailVerifiedAt: new Date(),
        membership: { create: { organizationId: user.organizationId, role } }
      }
    });
    await recordAudit(this.prisma, {
      organizationId: user.organizationId, actorId: user.userId, action: "team.member_invited",
      targetType: "User", targetId: created.id, metadata: { email, role }
    });
    return { userId: created.id, email, role, temporaryPassword };
  }

  async updateRole(user: AuthenticatedUser, targetUserId: string, role: string) {
    const nextRole = this.assertRole(role);
    await this.assertCanAssign(user, nextRole);
    const membership = await this.prisma.organizationMembership.findUnique({ where: { userId: targetUserId } });
    if (!membership || membership.organizationId !== user.organizationId) throw new NotFoundException("Team member not found in this organization");
    await this.assertCanAssign(user, membership.role as APP_ROLES);
    if (membership.userId === user.userId && nextRole !== APP_ROLES.ADMIN) {
      const adminCount = await this.prisma.organizationMembership.count({ where: { organizationId: user.organizationId, role: APP_ROLES.ADMIN } });
      if (adminCount <= 1) throw new BadRequestException("The organization must keep at least one admin");
    }
    const updated = await this.prisma.organizationMembership.update({ where: { userId: targetUserId }, data: { role: nextRole } });
    await recordAudit(this.prisma, {
      organizationId: user.organizationId, actorId: user.userId, action: "team.role_changed",
      targetType: "User", targetId: targetUserId, metadata: { role: nextRole }
    });
    return updated;
  }

  async remove(user: AuthenticatedUser, targetUserId: string) {
    if (targetUserId === user.userId) throw new BadRequestException("You cannot remove your own account");
    const membership = await this.prisma.organizationMembership.findUnique({ where: { userId: targetUserId } });
    if (!membership || membership.organizationId !== user.organizationId) throw new NotFoundException("Team member not found in this organization");
    await this.assertCanAssign(user, membership.role as APP_ROLES);
    const adminCount = await this.prisma.organizationMembership.count({ where: { organizationId: user.organizationId, role: APP_ROLES.ADMIN } });
    if (membership.role === APP_ROLES.ADMIN && adminCount <= 1) throw new BadRequestException("The organization must keep at least one admin");
    await this.prisma.user.delete({ where: { id: targetUserId } });
    await recordAudit(this.prisma, {
      organizationId: user.organizationId, actorId: user.userId, action: "team.member_removed",
      targetType: "User", targetId: targetUserId
    });
    return { removed: true };
  }

  /** `team:manage` holders may handle QA/DEVELOPER members; only an ADMIN may grant, change or remove ADMIN. */
  private async assertCanAssign(user: AuthenticatedUser, role: APP_ROLES) {
    if (role !== APP_ROLES.ADMIN) return;
    if ((await this.permissions.forUser(user)).role !== APP_ROLES.ADMIN) throw new ForbiddenException("Only organization admins can manage admin accounts");
  }

  private assertRole(role: string) {
    if (!appRoles.includes(role as APP_ROLES)) throw new BadRequestException(`role must be one of ${appRoles.join(", ")}`);
    return role as APP_ROLES;
  }
}
