import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { PERMISSIONS } from "@ai-qa/domain";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard, RequirePermission } from "../rbac/permissions.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { RouteMapService } from "./route-map.service";

@UseGuards(AuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PROJECTS_VIEW)
@Controller("v1/projects/:projectId/routes")
export class RouteMapController {
  constructor(private readonly routes: RouteMapService) {}

  @Get() list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.routes.list(user, projectId); }
  @Post() add(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: { pattern?: string; label?: string }) { return this.routes.add(user, projectId, body); }
  @Patch(":routeId") update(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("routeId") routeId: string, @Body() body: { pinned?: boolean; excluded?: boolean; label?: string; fixture?: Record<string, string> | null }) { return this.routes.update(user, projectId, routeId, body); }
  @Post(":routeId/verify") verify(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("routeId") routeId: string) { return this.routes.verify(user, projectId, routeId); }
}
