import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PermissionsService } from "../rbac/permissions.service";
import { RepositoryConnectionsService } from "../repository-connections/repository-connections.service";
import { CiService } from "../ci/ci.service";
import { PERMISSIONS } from "@ai-qa/domain";

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService, private readonly permissions: PermissionsService, private readonly connections: RepositoryConnectionsService, private readonly ci: CiService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.project.findMany({ where: { organizationId: user.organizationId }, orderBy: { createdAt: "desc" } });
  }

  /** Imports a repository from a connected account. Repository identity comes from the provider, not the client. */
  async create(user: AuthenticatedUser, input: { connectionId: string; repository: string; name?: string; defaultBranch?: string; rootDirectory?: string; backendDirectories?: unknown }) {
    const rootDirectory = normalizeRootDirectory(input.rootDirectory ?? "");
    const backendDirectories = normalizeBackendDirectories(input.backendDirectories);
    // Project count is a plan entitlement — enforced here, server-side.
    const org = await this.prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { name: true, subscription: { select: { plan: { select: { name: true, projectLimit: true } } } } }
    });
    const limit = org?.subscription?.plan?.projectLimit ?? 0;
    if (limit > 0) {
      const count = await this.prisma.project.count({ where: { organizationId: user.organizationId } });
      if (count >= limit) {
        throw new BadRequestException(`Your ${org?.subscription?.plan?.name ?? "current"} plan allows ${limit} projects. Upgrade your plan or archive a project to create more.`);
      }
    }
    const { connection, repository } = await this.connections.getRepository(user.organizationId, input.connectionId, input.repository);
    const duplicate = await this.prisma.project.findFirst({ where: { organizationId: user.organizationId, provider: connection.provider, externalRepoId: repository.externalId, rootDirectory }, select: { name: true } });
    if (duplicate) throw new BadRequestException(`${repository.fullName}${rootDirectory ? `/${rootDirectory}` : ""} is already imported as ${duplicate.name}. Pick a different root directory to add another project from this repository.`);
    const name = input.name?.trim() || (rootDirectory ? `${repository.fullName.split("/").pop()}-${rootDirectory.split("/").pop()}` : repository.fullName.split("/").pop()!);
    return this.prisma.project.create({
      data: {
        organizationId: user.organizationId, name, provider: connection.provider, repositoryConnectionId: connection.id,
        externalRepoId: repository.externalId, repoFullName: repository.fullName, repositoryUrl: repository.url, rootDirectory, backendDirectories,
        defaultBranch: input.defaultBranch?.trim() || repository.defaultBranch
      }
    });
  }

  /** Backend folders (outside rootDirectory) that analysis reads for endpoints and server-side rules. */
  async updateBackendDirectories(user: AuthenticatedUser, projectId: string, value: unknown) {
    await this.permissions.assert(user, PERMISSIONS.PROJECTS_EDIT);
    const backendDirectories = normalizeBackendDirectories(value);
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId }, select: { id: true } });
    if (!project) throw new NotFoundException("Project not found");
    return this.prisma.project.update({ where: { id: projectId }, data: { backendDirectories } });
  }

  async delete(user: AuthenticatedUser, projectId: string) {
    await this.permissions.assert(user, PERMISSIONS.PROJECTS_DELETE);
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    await this.ci.removeHook(project);
    await this.prisma.project.delete({ where: { id: projectId } });
  }
}

/** "apps/web" style subfolder; "" is the repository root. */
function normalizeRootDirectory(value: string) {
  const trimmed = value.trim().replace(/^\.?\/+|\/+$/g, "");
  if (!trimmed) return "";
  if (trimmed.length > 256 || !trimmed.split("/").every((segment) => /^[\w.@-]+$/.test(segment) && segment !== "." && segment !== "..")) {
    throw new BadRequestException("Root directory must be a relative folder path like apps/web");
  }
  return trimmed;
}

/** Accepts a string array or a comma-separated string; each entry validated like a root directory. */
function normalizeBackendDirectories(value: unknown) {
  if (value == null || value === "") return [];
  const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value as string[] : null;
  if (!raw) throw new BadRequestException("backendDirectories must be a list of folder paths");
  const dirs = [...new Set(raw.map((entry) => {
    try { return normalizeRootDirectory(entry); } catch { throw new BadRequestException("Backend directories must be relative folder paths like api or services/backend"); }
  }).filter(Boolean))];
  if (dirs.length > 10) throw new BadRequestException("At most 10 backend directories");
  return dirs;
}
