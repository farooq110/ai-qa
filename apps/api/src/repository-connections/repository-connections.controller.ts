import { BadRequestException, Controller, Delete, Get, Param, Query, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard, RequirePermission } from "../rbac/permissions.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { RepositoryConnectionsService, assertProviderName, type CallbackQuery } from "./repository-connections.service";
import { PERMISSIONS } from "@ai-qa/domain";

@Controller("v1/repository-connections")
export class RepositoryConnectionsController {
  constructor(private readonly connections: RepositoryConnectionsService) {}

  /** Connected accounts for the organization (Settings → Repository providers). */
  @UseGuards(AuthGuard)
  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.connections.list(user);
  }

  /** Disconnect a connected account. Admin only, audited. */
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @Delete(":connectionId")
  disconnect(@CurrentUser() user: AuthenticatedUser, @Param("connectionId") connectionId: string) {
    return this.connections.disconnect(user, connectionId);
  }

  /** Start connecting github | bitbucket | gitlab. `selfManaged=true` targets the org's own GitLab instance. */
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @Get(":provider/authorize")
  async authorize(@CurrentUser() user: AuthenticatedUser, @Param("provider") provider: string, @Query("selfManaged") selfManaged?: string, @Query("returnTo") returnTo?: string) {
    return this.connections.authorizationUrl(user, assertProviderName(provider), { selfManaged: selfManaged === "true", returnTo });
  }

  @Get(":provider/callback")
  async callback(@Param("provider") provider: string, @Query() query: CallbackQuery, @Res() reply?: FastifyReply) {
    const name = assertProviderName(provider);
    // WEB_APP_URL is already set in every deployment (auth emails, Stripe returns); without this fallback an unset
    // PUBLIC_APP_URL sent production users back to localhost after connecting.
    const webOrigin = (process.env.PUBLIC_APP_URL || process.env.WEB_APP_URL || "http://localhost:3004").replace(/\/$/, "");
    const back = (returnTo: string, connected: string) => `${webOrigin}${returnTo}?connected=${connected}&provider=${name.toLowerCase()}`;
    if (!reply) throw new BadRequestException("Response unavailable");
    try {
      const result = await this.connections.completeConnection(name, query);
      // Nest pre-sets the reply status to 200 before the handler runs, so the
      // code must be explicit — otherwise Fastify keeps 200 and browsers ignore
      // the location header, leaving a blank page on the callback URL.
      return reply.redirect(back(result.returnTo, result.pending ? "pending" : name.toLowerCase()), 302);
    } catch (error) {
      console.error(`Error completing ${name} connection:`, error);
      // Never render a raw error on the callback page — send the user back where the failure is explained.
      return reply.redirect(back("/settings", "error"), 302);
    }
  }

  /** Repositories a connection can import. */
  @UseGuards(AuthGuard)
  @Get(":connectionId/repositories")
  repositories(@CurrentUser() user: AuthenticatedUser, @Param("connectionId") connectionId: string, @Query("search") search?: string) {
    return this.connections.listRepositories(user, connectionId, search);
  }

  @UseGuards(AuthGuard)
  @Get(":connectionId/branches")
  branches(@CurrentUser() user: AuthenticatedUser, @Param("connectionId") connectionId: string, @Query("repository") repository?: string) {
    if (!repository) throw new BadRequestException("repository is required");
    return this.connections.listBranches(user, connectionId, repository);
  }
}
