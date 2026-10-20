import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard, RequirePermission } from "../rbac/permissions.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { GenerationsService } from "./generations.service";
import { PERMISSIONS } from "@ai-qa/domain";

@UseGuards(AuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.TEST_CASES_VIEW)
@Controller("v1/projects/:projectId/generations")
export class GenerationsController {
  constructor(private readonly generationsService: GenerationsService) {}
  @Get() list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.generationsService.list(user, projectId); }
  @Get(":generationId") get(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("generationId") generationId: string) { return this.generationsService.get(user, projectId, generationId); }
  @Post("candidates") generateCandidates(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.generationsService.generateCandidates(user, projectId); }

  /** Phase 5: spec-grounded generation, planned from the latest flow specs. `modules` restricts planning to those moduleKeys. */
  @Post("spec-candidates") generateSpecCandidates(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: { modules?: string[] }) {
    return this.generationsService.generateSpecCandidates(user, projectId, { modules: body.modules });
  }

  /** Plain-English flow -> AI-drafted test definition (reviewed in the editor before saving). */
  @Post("ai-draft") aiDraft(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: { description?: string }) {
    if (!body.description?.trim()) throw new BadRequestException("description is required");
    return this.generationsService.aiDraft(user, projectId, body.description.trim());
  }
}