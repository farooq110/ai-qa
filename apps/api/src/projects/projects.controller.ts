import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard, RequirePermission } from "../rbac/permissions.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { ProjectsService } from "./projects.service";
import { PERMISSIONS } from "@ai-qa/domain";

@UseGuards(AuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PROJECTS_VIEW)
@Controller("v1/projects")
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}
  @Get() list(@CurrentUser() user: AuthenticatedUser) { return this.projectsService.list(user); }
  @RequirePermission(PERMISSIONS.PROJECTS_CREATE)
  @Post() create(@CurrentUser() user: AuthenticatedUser, @Body() body: { connectionId?: string; repository?: string; name?: string; defaultBranch?: string; rootDirectory?: string; backendDirectories?: unknown }) {
    if (!body.connectionId || !body.repository) throw new BadRequestException("connectionId and repository are required");
    return this.projectsService.create(user, { connectionId: body.connectionId, repository: body.repository, name: body.name, defaultBranch: body.defaultBranch, rootDirectory: body.rootDirectory, backendDirectories: body.backendDirectories });
  }
  @RequirePermission(PERMISSIONS.PROJECTS_EDIT)
  @Patch(":projectId") update(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: { backendDirectories?: unknown }) {
    return this.projectsService.updateBackendDirectories(user, projectId, body.backendDirectories);
  }
  @Delete(":projectId") async delete(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    await this.projectsService.delete(user, projectId);
    return { deleted: true };
  }
}