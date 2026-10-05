import { BadRequestException, Controller, Delete, Get, Param, Query, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { RepositoryConnectionsService, assertProviderName } from "./repository-connections.service";

@Controller("v1/repository-connections")
export class RepositoryConnectionsController {
  constructor(private readonly connections: RepositoryConnectionsService) {}

  /** Connected accounts for the organization (Settings → Connected accounts). */
  @UseGuards(AuthGuard)
  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.connections.list(user);
  }

  /** Disconnect a connected account. Admin only, audited. */
  @UseGuards(AuthGuard)
  @Delete(":connectionId")
  disconnect(@CurrentUser() user: AuthenticatedUser, @Param("connectionId") connectionId: string) {
    return this.connections.disconnect(user, connectionId);
  }

  /** Start the OAuth dance for github | bitbucket | gitlab. */
  @UseGuards(AuthGuard)
  @Get(":provider/authorize")
  async authorize(@CurrentUser() user: AuthenticatedUser, @Param("provider") provider: string) {
    return this.connections.authorizationUrl(user, assertProviderName(provider));
  }

  @Get(":provider/callback")
  async callback(@Param("provider") provider: string, @Query("code") code?: string, @Query("state") state?: string, @Res() reply?: FastifyReply) {
    const name = assertProviderName(provider);
    const back = (connected: string) => `http://localhost:3004/settings?connected=${connected}&provider=${name.toLowerCase()}`;
    if (!reply) throw new BadRequestException("Response unavailable");
    try {
      if (!code || !state) throw new BadRequestException(`${name.toLowerCase()} callback requires code and state`);
      await this.connections.completeConnection(name, code, state);
      return reply.redirect(back(name.toLowerCase()));
    } catch {
      // Never render a raw error on the black callback page — send the user
      // back to Settings where the failure is explained in the UI.
      return reply.redirect(back("error"));
    }
  }

  /** Repositories accessible through the connected account. */
  @UseGuards(AuthGuard)
  @Get(":provider/repositories")
  repositories(@CurrentUser() user: AuthenticatedUser, @Param("provider") provider: string) {
    return this.connections.listRepositories(user, assertProviderName(provider));
  }

  @UseGuards(AuthGuard)
  @Get(":provider/branches")
  branches(@CurrentUser() user: AuthenticatedUser, @Param("provider") provider: string, @Query("repository") repository?: string) {
    if (!repository) throw new BadRequestException("repository is required");
    return this.connections.listBranches(user, assertProviderName(provider), repository);
  }

  // Backward-compatible aliases used by the existing dashboard/projects buttons.
  @UseGuards(AuthGuard)
  @Get("github/authorize")
  authorizeGithub(@CurrentUser() user: AuthenticatedUser) {
    return this.connections.authorizationUrl(user, "GITHUB");
  }

  @Get("github/callback")
  async githubCallback(@Query("code") code?: string, @Query("state") state?: string, @Res() reply?: FastifyReply) {
    if (!reply) throw new BadRequestException("Response unavailable");
    try {
      if (!code || !state) throw new BadRequestException("GitHub callback requires code and state");
      await this.connections.completeConnection("GITHUB", code, state);
      return reply.redirect("http://localhost:3004/settings?connected=github&provider=github");
    } catch {
      return reply.redirect("http://localhost:3004/settings?connected=error&provider=github");
    }
  }

  @UseGuards(AuthGuard)
  @Get("github/repositories")
  listGithubRepositories(@CurrentUser() user: AuthenticatedUser) {
    return this.connections.listRepositories(user, "GITHUB");
  }

  @UseGuards(AuthGuard)
  @Get("github/branches")
  listGithubBranches(@CurrentUser() user: AuthenticatedUser, @Query("repository") repository?: string) {
    if (!repository) throw new BadRequestException("repository is required");
    return this.connections.listBranches(user, "GITHUB", repository);
  }
}
