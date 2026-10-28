import { fixtureSets, type RouteFixtures } from "@ai-qa/test-dsl";
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { EnvironmentsService } from "./environments.service";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard, RequirePermission } from "../rbac/permissions.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PERMISSIONS } from "@ai-qa/domain";

@UseGuards(AuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.SETTINGS_VIEW)
@Controller("v1/projects/:projectId/environments")
export class EnvironmentsController {
  constructor(private readonly environmentsService: EnvironmentsService) {}

  @Get() list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.environmentsService.list(user, projectId); }

  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @Post() create(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: Record<string, unknown>) {
    if (!body.name?.toString().trim() || !body.url?.toString().trim()) throw new BadRequestException("name and url are required");
    return this.environmentsService.create(user, projectId, this.credentialInput(body) as { name: string; url: string; isDefault?: boolean });
  }

  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @Patch(":environmentId") update(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("environmentId") environmentId: string, @Body() body: Record<string, unknown>) {
    return this.environmentsService.update(user, projectId, environmentId, this.credentialInput(body));
  }

  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @Patch(":environmentId/default") setDefault(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("environmentId") environmentId: string) {
    return this.environmentsService.setDefault(user, projectId, environmentId);
  }

  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @Delete(":environmentId") delete(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("environmentId") environmentId: string) {
    return this.environmentsService.delete(user, projectId, environmentId);
  }

  /** { "/route": { param: "value" } } or { "/route": [{ param: "value" }, ...] } of strings only; anything else is rejected. */
  private fixtures(value: unknown): RouteFixtures | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("routeFixtures must be an object of route -> { parameter: value } (or a list of them)");
    const out: RouteFixtures = {};
    for (const [route, params] of Object.entries(value as Record<string, unknown>)) {
      const list = Array.isArray(params) ? params : [params];
      if (!list.length || list.some((set) => !set || typeof set !== "object" || Array.isArray(set))) throw new BadRequestException(`routeFixtures["${route}"] must be { parameter: value } or a non-empty list of them`);
      const sets = fixtureSets(list);
      out[route] = Array.isArray(params) ? sets : sets[0];
    }
    return out;
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
      password: str("password"),
      routeFixtures: this.fixtures(body.routeFixtures)
    };
  }
}
