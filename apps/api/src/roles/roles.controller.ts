import { BadRequestException, Body, Controller, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PermissionsGuard, RequirePermission } from "../rbac/permissions.guard";
import { RolesService } from "./roles.service";
import { PERMISSIONS } from "@ai-qa/domain";

@UseGuards(AuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.ROLES_VIEW)
@Controller("v1/roles")
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get() list(@CurrentUser() user: AuthenticatedUser) { return this.rolesService.list(user); }

  @RequirePermission(PERMISSIONS.ROLES_MANAGE)
  @Put(":role") update(@CurrentUser() user: AuthenticatedUser, @Param("role") role: string, @Body() body: { permissions?: unknown[] }) {
    if (!Array.isArray(body.permissions)) throw new BadRequestException("permissions must be an array");
    return this.rolesService.update(user, role, body.permissions);
  }

  @RequirePermission(PERMISSIONS.ROLES_MANAGE)
  @Post(":role/reset") reset(@CurrentUser() user: AuthenticatedUser, @Param("role") role: string) { return this.rolesService.reset(user, role); }
}
