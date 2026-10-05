import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.project.findMany({ where: { organizationId: user.organizationId }, orderBy: { createdAt: "desc" } });
  }

  create(user: AuthenticatedUser, input: { name: string; repositoryUrl: string; defaultBranch?: string }) {
    return this.prisma.project.create({ data: { organizationId: user.organizationId, name: input.name, repositoryUrl: input.repositoryUrl, defaultBranch: input.defaultBranch ?? "main" } });
  }

  async delete(user: AuthenticatedUser, projectId: string) {
    if (user.role !== "ADMIN") throw new ForbiddenException("Only organization admins can delete projects");
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    await this.prisma.project.delete({ where: { id: projectId } });
  }
}