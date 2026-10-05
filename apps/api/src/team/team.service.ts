import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { recordAudit } from "../common/audit";

const assignableRoles = ["ADMIN", "QA", "DEVELOPER"] as const;

@Injectable()
export class TeamService {
  constructor(private readonly prisma: PrismaService) {}

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
    this.assertAdmin(user);
    const role = this.assertRole(input.role);
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
    this.assertAdmin(user);
    const nextRole = this.assertRole(role);
    const membership = await this.prisma.organizationMembership.findUnique({ where: { userId: targetUserId } });
    if (!membership || membership.organizationId !== user.organizationId) throw new NotFoundException("Team member not found in this organization");
    if (membership.userId === user.userId && nextRole !== "ADMIN") {
      const adminCount = await this.prisma.organizationMembership.count({ where: { organizationId: user.organizationId, role: "ADMIN" } });
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
    this.assertAdmin(user);
    if (targetUserId === user.userId) throw new BadRequestException("You cannot remove your own account");
    const membership = await this.prisma.organizationMembership.findUnique({ where: { userId: targetUserId } });
    if (!membership || membership.organizationId !== user.organizationId) throw new NotFoundException("Team member not found in this organization");
    const adminCount = await this.prisma.organizationMembership.count({ where: { organizationId: user.organizationId, role: "ADMIN" } });
    if (membership.role === "ADMIN" && adminCount <= 1) throw new BadRequestException("The organization must keep at least one admin");
    await this.prisma.user.delete({ where: { id: targetUserId } });
    await recordAudit(this.prisma, {
      organizationId: user.organizationId, actorId: user.userId, action: "team.member_removed",
      targetType: "User", targetId: targetUserId
    });
    return { removed: true };
  }

  private assertAdmin(user: AuthenticatedUser) {
    if (user.role !== "ADMIN") throw new ForbiddenException("Only organization admins can manage the team");
  }

  private assertRole(role: string) {
    if (!assignableRoles.includes(role as (typeof assignableRoles)[number])) throw new BadRequestException("role must be one of ADMIN, QA, DEVELOPER");
    return role as (typeof assignableRoles)[number];
  }
}
