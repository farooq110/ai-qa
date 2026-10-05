import { BadRequestException, Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CiService } from "./ci.service";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";

@UseGuards(AuthGuard)
@Controller("v1/projects/:projectId/ci")
export class CiController {
  constructor(private readonly ciService: CiService) {}

  @Get("connections") list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.ciService.listConnections(user, projectId); }

  @Post("connections") create(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: { provider?: string; label?: string }) {
    if (!body.provider) throw new BadRequestException("provider is required");
    return this.ciService.createConnection(user, projectId, { provider: body.provider, label: body.label });
  }

  @Delete("connections/:connectionId") remove(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("connectionId") connectionId: string) {
    return this.ciService.deleteConnection(user, projectId, connectionId);
  }

  @Get("requests") requests(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.ciService.listRequests(user, projectId); }
}

@Controller("v1/ci")
export class CiWebhookController {
  constructor(private readonly ciService: CiService) {}

  @Post("push")
  push(@Body() body: { token?: string; provider?: string; repository?: string; branch?: string; commitSha?: string; pipelineId?: string }) {
    return this.ciService.handlePush({
      token: body.token,
      provider: body.provider,
      repository: body.repository,
      branch: body.branch,
      commitSha: body.commitSha,
      pipelineId: body.pipelineId
    });
  }
}
