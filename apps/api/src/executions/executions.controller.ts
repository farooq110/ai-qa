import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ExecutionsService } from "./executions.service";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";

@UseGuards(AuthGuard)
@Controller("v1/projects/:projectId/executions")
export class ExecutionsController {
  constructor(private readonly executionsService: ExecutionsService) {}

  @Get() list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.executionsService.list(user, projectId); }

  @Get(":planId") detail(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("planId") planId: string) {
    return this.executionsService.detail(user, projectId, planId);
  }

  @Post() create(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: { testCaseIds?: string[]; branch?: string; commitSha?: string; environmentUrl?: string; environmentId?: string; trigger?: "DASHBOARD" | "CI" | "RERUN" }) {
    if (!body.testCaseIds?.length) throw new BadRequestException("testCaseIds is required");
    return this.executionsService.create(user, projectId, body);
  }

  @Post("run-all") runAll(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: { branch?: string; environmentId?: string; environmentUrl?: string }) {
    return this.executionsService.runAllApproved(user, projectId, body ?? {});
  }

  @Post(":planId/rerun-failed") rerunFailed(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("planId") planId: string) {
    return this.executionsService.rerunFailed(user, projectId, planId);
  }

  @Patch(":planId/cancel") cancel(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("planId") planId: string) {
    return this.executionsService.cancel(user, projectId, planId);
  }
}

@UseGuards(AuthGuard)
@Controller("v1/executions")
export class ExecutionsLibraryController {
  constructor(private readonly executionsService: ExecutionsService) {}

  /** Org-wide run history: GET /v1/executions?projectId=... */
  @Get() list(@CurrentUser() user: AuthenticatedUser, @Query("projectId") projectId?: string) {
    return this.executionsService.listAcrossProjects(user, { projectId: projectId || undefined });
  }
}
