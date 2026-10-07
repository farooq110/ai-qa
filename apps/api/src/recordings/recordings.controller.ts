import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { RecordingsService } from "./recordings.service";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";

@UseGuards(AuthGuard)
@Controller("v1/projects/:projectId/recordings")
export class RecordingsController {
  constructor(private readonly recordingsService: RecordingsService) {}

  @Post() start(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: { url?: string }) {
    if (!body.url?.trim()) throw new BadRequestException("url is required");
    return this.recordingsService.start(user, projectId, body.url.trim());
  }

  @Get(":sessionId") events(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("sessionId") sessionId: string) {
    return this.recordingsService.events(user, projectId, sessionId);
  }

  @Get(":sessionId/screenshot") screenshot(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("sessionId") sessionId: string) {
    return this.recordingsService.screenshot(user, projectId, sessionId);
  }

  @Post(":sessionId/stop") stop(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("sessionId") sessionId: string) {
    return this.recordingsService.stop(user.organizationId, projectId, sessionId);
  }
}
