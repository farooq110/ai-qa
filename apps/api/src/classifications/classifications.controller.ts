import { BadRequestException, Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard, RequirePermission } from "../rbac/permissions.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { ClassificationsService } from "./classifications.service";
import { PERMISSIONS } from "@ai-qa/domain";

@UseGuards(AuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.TEST_CASES_VIEW)
@Controller("v1/classifications")
export class ClassificationsController {
  constructor(private readonly classificationsService: ClassificationsService) {}
  @Get() list(@CurrentUser() user: AuthenticatedUser) { return this.classificationsService.list(user); }
  @RequirePermission(PERMISSIONS.TEST_CASES_EDIT)
  @Post("modules") createModule(@CurrentUser() user: AuthenticatedUser, @Body() body: { name?: string }) { if (!body.name?.trim()) throw new BadRequestException("name is required"); return this.classificationsService.createModule(user, body.name); }
  @RequirePermission(PERMISSIONS.TEST_CASES_EDIT)
  @Delete("modules/:moduleId") deleteModule(@CurrentUser() user: AuthenticatedUser, @Param("moduleId") moduleId: string) {
    return this.classificationsService.deleteModule(user, moduleId);
  }

  @RequirePermission(PERMISSIONS.TEST_CASES_EDIT)
  @Delete("tags/:tagId") deleteTag(@CurrentUser() user: AuthenticatedUser, @Param("tagId") tagId: string) {
    return this.classificationsService.deleteTag(user, tagId);
  }

  @RequirePermission(PERMISSIONS.TEST_CASES_EDIT)
  @Post("tags") createTag(@CurrentUser() user: AuthenticatedUser, @Body() body: { name?: string }) { if (!body.name?.trim()) throw new BadRequestException("name is required"); return this.classificationsService.createTag(user, body.name); }
}