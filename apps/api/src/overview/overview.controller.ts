import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { OverviewService } from "./overview.service";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard, RequirePermission } from "../rbac/permissions.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PERMISSIONS } from "@ai-qa/domain";

@UseGuards(AuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.DASHBOARD_VIEW)
@Controller("v1/projects/:projectId/overview")
export class OverviewController {
  constructor(private readonly overviewService: OverviewService) {}

  @Get() overview(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.overviewService.projectOverview(user, projectId);
  }
}
