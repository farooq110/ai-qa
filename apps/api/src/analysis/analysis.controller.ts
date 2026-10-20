import { Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard, RequirePermission } from "../rbac/permissions.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { AnalysisService } from "./analysis.service";
import { PERMISSIONS } from "@ai-qa/domain";

@UseGuards(AuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PROJECTS_VIEW)
@Controller("v1/projects/:projectId/analysis")
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}
  @Get() list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.analysis.list(user, projectId); }
  @Post() run(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Query("branch") branch?: string) { return this.analysis.analyze(user, projectId, branch); }
}