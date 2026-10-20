import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Req, UseGuards, type RawBodyRequest } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { CiService, type BitbucketPayload, type GithubPayload, type GitlabPayload } from "./ci.service";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard, RequirePermission } from "../rbac/permissions.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PERMISSIONS } from "@ai-qa/domain";

@UseGuards(AuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.CI_CD_VIEW)
@Controller("v1/projects/:projectId/ci")
export class CiController {
  constructor(private readonly ciService: CiService) {}

  @Get() settings(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.ciService.getSettings(user, projectId); }

  @RequirePermission(PERMISSIONS.CI_CD_EDIT)
  @Put() save(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: Record<string, unknown>) { return this.ciService.saveSettings(user, projectId, body ?? {}); }

  @Get("workflows") workflows(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.ciService.listWorkflows(user, projectId); }

  @Get("runs") runs(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.ciService.listRuns(user, projectId); }
}

/** Provider webhooks. Unauthenticated by design — each request is verified by signature or token instead. */
@Controller("v1/webhooks")
export class CiWebhookController {
  constructor(private readonly ciService: CiService) {}

  @HttpCode(200)
  @Post("github")
  github(@Req() request: RawBodyRequest<FastifyRequest>, @Headers("x-hub-signature-256") signature: string | undefined, @Headers("x-github-event") event: string | undefined, @Body() body: GithubPayload) {
    return this.ciService.handleGithub(request.rawBody, signature, event, body);
  }

  @HttpCode(200)
  @Post("gitlab/:projectId")
  gitlab(@Param("projectId") projectId: string, @Headers("x-gitlab-token") token: string | undefined, @Body() body: GitlabPayload) {
    return this.ciService.handleGitlab(projectId, token, body);
  }

  @HttpCode(200)
  @Post("bitbucket/:projectId")
  bitbucket(@Param("projectId") projectId: string, @Req() request: RawBodyRequest<FastifyRequest>, @Headers("x-hub-signature") signature: string | undefined, @Headers("x-event-key") event: string | undefined, @Body() body: BitbucketPayload) {
    return this.ciService.handleBitbucket(projectId, request.rawBody, signature, event, body);
  }
}
