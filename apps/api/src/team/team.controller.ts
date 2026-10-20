import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { TeamService } from "./team.service";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard, RequirePermission } from "../rbac/permissions.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PERMISSIONS } from "@ai-qa/domain";

@UseGuards(AuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.TEAM_VIEW)
@Controller("v1/team")
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @Get() list(@CurrentUser() user: AuthenticatedUser) { return this.teamService.list(user); }

  @RequirePermission(PERMISSIONS.TEAM_MANAGE)
  @Post("invite") invite(@CurrentUser() user: AuthenticatedUser, @Body() body: { email?: string; displayName?: string; role?: string; password?: string }) {
    if (!body.email?.trim() || !body.displayName?.trim() || !body.role) throw new BadRequestException("email, displayName, and role are required");
    return this.teamService.invite(user, { email: body.email, displayName: body.displayName, role: body.role, password: body.password });
  }

  @RequirePermission(PERMISSIONS.TEAM_MANAGE)
  @Patch(":userId/role") updateRole(@CurrentUser() user: AuthenticatedUser, @Param("userId") userId: string, @Body() body: { role?: string }) {
    if (!body.role) throw new BadRequestException("role is required");
    return this.teamService.updateRole(user, userId, body.role);
  }

  @RequirePermission(PERMISSIONS.TEAM_MANAGE)
  @Delete(":userId") remove(@CurrentUser() user: AuthenticatedUser, @Param("userId") userId: string) {
    return this.teamService.remove(user, userId);
  }
}
