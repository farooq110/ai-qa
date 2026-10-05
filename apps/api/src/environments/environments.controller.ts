import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { EnvironmentsService } from "./environments.service";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";

@UseGuards(AuthGuard)
@Controller("v1/projects/:projectId/environments")
export class EnvironmentsController {
  constructor(private readonly environmentsService: EnvironmentsService) {}

  @Get() list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.environmentsService.list(user, projectId); }

  @Post() create(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: Record<string, unknown>) {
    if (!body.name?.toString().trim() || !body.url?.toString().trim()) throw new BadRequestException("name and url are required");
    return this.environmentsService.create(user, projectId, this.credentialInput(body) as { name: string; url: string; isDefault?: boolean });
  }

  @Patch(":environmentId") update(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("environmentId") environmentId: string, @Body() body: Record<string, unknown>) {
    return this.environmentsService.update(user, projectId, environmentId, this.credentialInput(body));
  }

  @Patch(":environmentId/default") setDefault(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("environmentId") environmentId: string) {
    return this.environmentsService.setDefault(user, projectId, environmentId);
  }

  @Delete(":environmentId") delete(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("environmentId") environmentId: string) {
    return this.environmentsService.delete(user, projectId, environmentId);
  }

  private credentialInput(body: Record<string, unknown>) {
    const str = (key: string) => (body[key] !== undefined && body[key] !== null ? body[key].toString() : undefined);
    return {
      name: str("name"),
      url: str("url"),
      isDefault: body.isDefault === undefined ? undefined : Boolean(body.isDefault),
      loginUrl: str("loginUrl"),
      loginTrigger: str("loginTrigger"),
      usernameSelector: str("usernameSelector"),
      passwordSelector: str("passwordSelector"),
      submitSelector: str("submitSelector"),
      username: str("username"),
      password: str("password")
    };
  }
}
