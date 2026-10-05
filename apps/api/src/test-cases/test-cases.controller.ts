import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { TestCasesService } from "./test-cases.service";

@UseGuards(AuthGuard)
@Controller("v1/projects/:projectId/test-cases")
export class TestCasesController {
  constructor(private readonly testCasesService: TestCasesService) {}

  @Get() list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) { return this.testCasesService.list(user, projectId); }

  @Post() create(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: Record<string, unknown> & { title?: string; steps?: unknown[] }) {
    if (!body.title?.toString().trim()) throw new BadRequestException("title is required");
    const steps = Array.isArray(body.steps) ? body.steps as Array<{ action: string; target: string; value?: string; condition?: string }> : [];
    if (!steps.length) throw new BadRequestException("At least one test step is required");
    return this.testCasesService.createManual(user, projectId, {
      title: body.title.toString(),
      capability: body.capability?.toString(),
      category: body.category?.toString(),
      priority: body.priority?.toString(),
      route: body.route?.toString(),
      preconditions: Array.isArray(body.preconditions) ? body.preconditions.map(String) : [],
      steps,
      expectedResult: body.expectedResult?.toString() ?? "",
      moduleIds: Array.isArray(body.moduleIds) ? body.moduleIds.map(String) : [],
      tagIds: Array.isArray(body.tagIds) ? body.tagIds.map(String) : []
    });
  }

  @Patch(":testCaseId") update(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("testCaseId") testCaseId: string, @Body() body: Record<string, unknown>) {
    return this.testCasesService.update(user, projectId, testCaseId, {
      title: body.title?.toString(),
      capability: body.capability?.toString(),
      category: body.category?.toString(),
      priority: body.priority?.toString(),
      route: body.route?.toString(),
      preconditions: Array.isArray(body.preconditions) ? body.preconditions.map(String) : undefined,
      steps: Array.isArray(body.steps) ? body.steps as Array<{ action: string; target: string; value?: string; condition?: string }> : undefined,
      expectedResult: body.expectedResult?.toString(),
      note: body.note?.toString(),
      moduleIds: Array.isArray(body.moduleIds) ? body.moduleIds.map(String) : undefined,
      tagIds: Array.isArray(body.tagIds) ? body.tagIds.map(String) : undefined
    });
  }

  @Patch(":testCaseId/approve") approve(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("testCaseId") testCaseId: string) { return this.testCasesService.approve(user, projectId, testCaseId); }
  @Patch(":testCaseId/reject") reject(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("testCaseId") testCaseId: string) { return this.testCasesService.reject(user, projectId, testCaseId); }

  @Post("bulk/status") bulkStatus(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: { testCaseIds?: string[]; action?: "approve" | "reject" | "archive" }) {
    if (!body.testCaseIds?.length || !body.action) throw new BadRequestException("testCaseIds and action are required");
    return this.testCasesService.bulkStatus(user, projectId, { testCaseIds: body.testCaseIds, action: body.action });
  }

  @Delete(":testCaseId") remove(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("testCaseId") testCaseId: string) {
    return this.testCasesService.remove(user, projectId, testCaseId);
  }

  @Post("bulk/delete") bulkDelete(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: { testCaseIds?: string[] }) {
    if (!body.testCaseIds?.length) throw new BadRequestException("testCaseIds is required");
    return this.testCasesService.bulkDelete(user, projectId, body.testCaseIds);
  }

  @Post("bulk/classify") bulkClassify(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: { testCaseIds?: string[]; addModuleIds?: string[]; removeModuleIds?: string[]; addTagIds?: string[]; removeTagIds?: string[]; moveModuleId?: string }) {
    if (!body.testCaseIds?.length) throw new BadRequestException("testCaseIds is required");
    return this.testCasesService.bulkClassify(user, projectId, body as { testCaseIds: string[] });
  }
}

@UseGuards(AuthGuard)
@Controller("v1/test-cases")
export class TestCasesLibraryController {
  constructor(private readonly testCasesService: TestCasesService) {}

  /** Library view across all of the organization's projects, filterable by project and repository provider. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query("projectId") projectId?: string, @Query("provider") provider?: string) {
    return this.testCasesService.listAcrossProjects(user, { projectId: projectId || undefined, provider: provider?.toUpperCase() || undefined });
  }
}
