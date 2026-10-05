import { BadRequestException, Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { ClassificationsService } from "./classifications.service";

@UseGuards(AuthGuard)
@Controller("v1/classifications")
export class ClassificationsController {
  constructor(private readonly classificationsService: ClassificationsService) {}
  @Get() list(@CurrentUser() user: AuthenticatedUser) { return this.classificationsService.list(user); }
  @Post("modules") createModule(@CurrentUser() user: AuthenticatedUser, @Body() body: { name?: string }) { if (!body.name?.trim()) throw new BadRequestException("name is required"); return this.classificationsService.createModule(user, body.name); }
  @Delete("modules/:moduleId") deleteModule(@CurrentUser() user: AuthenticatedUser, @Param("moduleId") moduleId: string) {
    return this.classificationsService.deleteModule(user, moduleId);
  }

  @Delete("tags/:tagId") deleteTag(@CurrentUser() user: AuthenticatedUser, @Param("tagId") tagId: string) {
    return this.classificationsService.deleteTag(user, tagId);
  }

  @Post("tags") createTag(@CurrentUser() user: AuthenticatedUser, @Body() body: { name?: string }) { if (!body.name?.trim()) throw new BadRequestException("name is required"); return this.classificationsService.createTag(user, body.name); }
}