import { BadRequestException, Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { ProjectsService } from "./projects.service";

@UseGuards(AuthGuard)
@Controller("v1/projects")
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}
  @Get() list(@CurrentUser() user: AuthenticatedUser) { return this.projectsService.list(user); }
  @Post() create(@CurrentUser() user: AuthenticatedUser, @Body() body: { name?: string; repositoryUrl?: string; defaultBranch?: string }) {
    if (!body.name || !body.repositoryUrl) throw new BadRequestException("name and repositoryUrl are required");
    return this.projectsService.create(user, { name: body.name, repositoryUrl: body.repositoryUrl, defaultBranch: body.defaultBranch });
  }
  @Delete(":projectId") async delete(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    await this.projectsService.delete(user, projectId);
    return { deleted: true };
  }
}