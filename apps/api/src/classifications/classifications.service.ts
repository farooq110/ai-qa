import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { recordAudit } from "../common/audit";

@Injectable()
export class ClassificationsService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser) {
    return Promise.all([
      this.prisma.testModule.findMany({ where: { organizationId: user.organizationId }, orderBy: { name: "asc" } }),
      this.prisma.testTag.findMany({ where: { organizationId: user.organizationId }, orderBy: { name: "asc" } })
    ]).then(([modules, tags]) => ({ modules, tags }));
  }

  createModule(user: AuthenticatedUser, name: string) {
    return this.prisma.testModule.create({ data: { organizationId: user.organizationId, name: name.trim() } });
  }

  async deleteModule(user: AuthenticatedUser, moduleId: string) {
    const module = await this.prisma.testModule.findFirst({ where: { id: moduleId, organizationId: user.organizationId } });
    if (!module) throw new NotFoundException("Module not found");
    // Memberships cascade; the test cases themselves are never deleted.
    await this.prisma.testModule.delete({ where: { id: moduleId } });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "classification.module_deleted", targetType: "TestModule", targetId: moduleId, metadata: { name: module.name } });
    return { deleted: true, name: module.name };
  }

  async deleteTag(user: AuthenticatedUser, tagId: string) {
    const tag = await this.prisma.testTag.findFirst({ where: { id: tagId, organizationId: user.organizationId } });
    if (!tag) throw new NotFoundException("Tag not found");
    await this.prisma.testTag.delete({ where: { id: tagId } });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "classification.tag_deleted", targetType: "TestTag", targetId: tagId, metadata: { name: tag.name } });
    return { deleted: true, name: tag.name };
  }

  createTag(user: AuthenticatedUser, name: string) {
    return this.prisma.testTag.create({ data: { organizationId: user.organizationId, name: name.trim() } });
  }
}