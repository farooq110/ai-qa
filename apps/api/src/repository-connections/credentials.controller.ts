import { BadRequestException, Body, Controller, Delete, Get, Put, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { RepositoryConnectionsService } from "./repository-connections.service";

interface CredentialPayload { baseUrl?: unknown; clientId?: unknown; clientSecret?: unknown }

/** BYO OAuth app for a self-managed GitLab instance — the only provider that still needs one.
 *  Any member can read the status; saving/removing is admin-only and audited. Secrets are write-only. */
@Controller("v1/repository-connections/gitlab/self-managed")
export class IntegrationCredentialsController {
  constructor(private readonly connections: RepositoryConnectionsService) {}

  @UseGuards(AuthGuard)
  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.connections.getSelfManagedGitlab(user);
  }

  @UseGuards(AuthGuard)
  @Put()
  save(@CurrentUser() user: AuthenticatedUser, @Body() body: CredentialPayload) {
    const [baseUrl, clientId, clientSecret] = [body.baseUrl, body.clientId, body.clientSecret].map((value) => typeof value === "string" ? value.trim() : "");
    if (!baseUrl || !clientId || !clientSecret) throw new BadRequestException("baseUrl, clientId and clientSecret are required");
    if (baseUrl.length > 512 || clientId.length > 512 || clientSecret.length > 2048) throw new BadRequestException("baseUrl, clientId or clientSecret is too long");
    return this.connections.saveSelfManagedGitlab(user, { baseUrl, clientId, clientSecret });
  }

  @UseGuards(AuthGuard)
  @Delete()
  remove(@CurrentUser() user: AuthenticatedUser) {
    return this.connections.removeSelfManagedGitlab(user);
  }
}
