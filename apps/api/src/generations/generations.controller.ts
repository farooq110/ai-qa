import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { GenerationsService } from "./generations.service";

@UseGuards(AuthGuard)
@Controller("v1/projects/:projectId/generations")
export class GenerationsController {
  constructor(private readonly generationsService: GenerationsService) {}
  @Get() list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.generationsService.list(user, projectId); }
  @Post() request(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: { targetCommit?: string; baseCommit?: string; mode?: "INCREMENTAL" | "FULL" }) {
    if (body.mode && !["INCREMENTAL", "FULL"].includes(body.mode)) throw new BadRequestException("mode must be INCREMENTAL or FULL");
    return this.generationsService.request(user, projectId, { targetCommit: body.targetCommit, baseCommit: body.baseCommit, mode: body.mode });
  }
  @Post("candidates") generateCandidates(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.generationsService.generateCandidates(user, projectId); }

  /** Plain-English flow -> AI-drafted test definition (reviewed in the editor before saving). */
  @Post("ai-draft") aiDraft(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: { description?: string }) {
    if (!body.description?.trim()) throw new BadRequestException("description is required");
    return this.generationsService.aiDraft(user, projectId, body.description.trim());
  }
}