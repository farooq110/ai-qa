import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { recordAudit } from "../common/audit";
import type { TestDefinition } from "@ai-qa/test-dsl";
import { validateTestDefinition } from "@ai-qa/test-dsl";

interface CreateManualInput {
  title: string;
  capability?: string;
  category?: string;
  priority?: string;
  route?: string;
  preconditions?: string[];
  steps: Array<{ action: string; target: string; value?: string; condition?: string }>;
  expectedResult: string;
  moduleIds?: string[];
  tagIds?: string[];
}

interface UpdateInput {
  title?: string;
  capability?: string;
  category?: string;
  priority?: string;
  route?: string;
  preconditions?: string[];
  steps?: Array<{ action: string; target: string; value?: string; condition?: string }>;
  expectedResult?: string;
  note?: string;
  moduleIds?: string[];
  tagIds?: string[];
}

const categories = ["HAPPY_PATH", "NEGATIVE", "BOUNDARY", "VALIDATION", "PERMISSION", "ERROR", "STATE", "INTEGRATION"];
const priorities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

@Injectable()
export class TestCasesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser, projectId: string) {
    await this.assertProjectOwnership(user, projectId);
    return this.prisma.testCase.findMany({
      where: { projectId },
      include: {
        modules: { include: { module: true } },
        tags: { include: { tag: true } },
        versions: { orderBy: { version: "desc" }, take: 5 }
      },
      orderBy: { createdAt: "desc" }
    });
  }

  /**
   * Cross-project library view, tenant-scoped. Optionally narrows to one project
   * and/or to projects whose repository URL belongs to a given provider.
   */
  async listAcrossProjects(user: AuthenticatedUser, filters: { projectId?: string; provider?: string }) {
    const projects = await this.prisma.project.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true, repositoryUrl: true }
    });
    const providerOf = (url: string) => /bitbucket\.org/i.test(url) ? "BITBUCKET" : /gitlab/i.test(url) ? "GITLAB" : "GITHUB";
    let candidates = projects;
    if (filters.provider) candidates = candidates.filter((project) => providerOf(project.repositoryUrl) === filters.provider);
    if (filters.projectId) candidates = candidates.filter((project) => project.id === filters.projectId);
    if (!candidates.length) return [];

    const tests = await this.prisma.testCase.findMany({
      where: { projectId: { in: candidates.map((project) => project.id) } },
      include: {
        modules: { include: { module: true } },
        tags: { include: { tag: true } },
        versions: { orderBy: { version: "desc" }, take: 5 }
      },
      orderBy: { createdAt: "desc" }
    });
    const meta = new Map(candidates.map((project) => [project.id, { projectName: project.name, provider: providerOf(project.repositoryUrl) }]));
    return tests.map((test) => ({ ...test, ...(meta.get(test.projectId) ?? { projectName: "Unknown", provider: "GITHUB" }) }));
  }

  async createManual(user: AuthenticatedUser, projectId: string, input: CreateManualInput) {
    await this.assertProjectOwnership(user, projectId);
    if (user.role === "DEVELOPER") throw new ForbiddenException("This role cannot create test cases");
    const definition = this.buildDefinition(input);
    const moduleIds = [...new Set(input.moduleIds ?? [])];
    const tagIds = [...new Set(input.tagIds ?? [])];
    await this.assertOrganizationClassifications(user.organizationId, moduleIds, tagIds);
    const testCase = await this.prisma.testCase.create({
      data: {
        projectId,
        title: input.title.trim(),
        source: "MANUAL",
        capability: input.capability?.trim() || undefined,
        category: this.pickCategory(input.category),
        priority: this.pickPriority(input.priority),
        route: input.route?.trim() || undefined,
        definition: definition as never,
        status: "PENDING_REVIEW",
        versions: { create: { version: 1, title: input.title.trim(), definition: definition as never, note: "Manually created" } },
        modules: { create: moduleIds.map((moduleId) => ({ moduleId })) },
        tags: { create: tagIds.map((tagId) => ({ tagId })) }
      },
      include: { modules: { include: { module: true } }, tags: { include: { tag: true } } }
    });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "test.created", targetType: "TestCase", targetId: testCase.id });
    return testCase;
  }

  async update(user: AuthenticatedUser, projectId: string, testCaseId: string, input: UpdateInput) {
    await this.assertProjectOwnership(user, projectId);
    if (user.role === "DEVELOPER") throw new ForbiddenException("This role cannot edit test cases");
    const existing = await this.prisma.testCase.findFirst({ where: { id: testCaseId, projectId } });
    if (!existing) throw new NotFoundException("Test case not found");
    if (existing.status === "ARCHIVED" || existing.status === "REJECTED") throw new BadRequestException("Archived or rejected tests cannot be edited");

    const current = existing.definition as unknown as Partial<TestDefinition> | null;
    const merged: CreateManualInput = {
      title: input.title?.trim() || existing.title,
      capability: input.capability ?? current?.capability,
      category: input.category ?? current?.category,
      priority: input.priority ?? existing.priority,
      route: input.route ?? existing.route ?? undefined,
      preconditions: input.preconditions ?? current?.preconditions ?? [],
      steps: (input.steps && input.steps.length ? input.steps : current?.steps) ?? [],
      expectedResult: input.expectedResult ?? current?.expectedResult ?? ""
    };
    const definition = this.buildDefinition(merged);
    const nextVersion = existing.version + 1;
    const statusAfterEdit = existing.status === "APPROVED" ? "PENDING_REVIEW" : existing.status;

    // Classification sync: when the caller sends moduleIds/tagIds, replace the
    // test's memberships with exactly that set; when omitted, leave them untouched.
    const moduleIds = input.moduleIds ? [...new Set(input.moduleIds)] : null;
    const tagIds = input.tagIds ? [...new Set(input.tagIds)] : null;
    if (moduleIds || tagIds) {
      await this.assertOrganizationClassifications(user.organizationId, moduleIds ?? [], tagIds ?? []);
    }

    await this.prisma.$transaction([
      this.prisma.testCase.update({
        where: { id: testCaseId },
        data: {
          title: merged.title,
          status: statusAfterEdit,
          capability: merged.capability || undefined,
          category: this.pickCategory(merged.category),
          priority: this.pickPriority(merged.priority),
          route: merged.route || undefined,
          definition: definition as never,
          version: nextVersion
        },
        include: { modules: { include: { module: true } }, tags: { include: { tag: true } } }
      }),
      this.prisma.testCaseVersion.create({
        data: { testCaseId, version: nextVersion, title: merged.title, definition: definition as never, note: input.note?.trim() || undefined }
      }),
      ...(moduleIds ? [
        this.prisma.testModuleMembership.deleteMany({ where: { testCaseId, moduleId: { notIn: moduleIds } } }),
        this.prisma.testModuleMembership.createMany({ data: moduleIds.map((moduleId) => ({ moduleId, testCaseId })), skipDuplicates: true })
      ] : []),
      ...(tagIds ? [
        this.prisma.testTagAssignment.deleteMany({ where: { testCaseId, tagId: { notIn: tagIds } } }),
        this.prisma.testTagAssignment.createMany({ data: tagIds.map((tagId) => ({ tagId, testCaseId })), skipDuplicates: true })
      ] : [])
    ]);
    // The transaction returns the update's snapshot before classification rows
    // were synced — re-read so callers see the memberships they just set.
    const fresh = await this.prisma.testCase.findUniqueOrThrow({
      where: { id: testCaseId },
      include: { modules: { include: { module: true } }, tags: { include: { tag: true } } }
    });
    await recordAudit(this.prisma, {
      organizationId: user.organizationId, actorId: user.userId, action: "test.edited",
      targetType: "TestCase", targetId: testCaseId, metadata: { version: nextVersion, previousStatus: existing.status }
    });
    return fresh;
  }

  async approve(user: AuthenticatedUser, projectId: string, testCaseId: string) {
    await this.assertProjectOwnership(user, projectId);
    if (user.role === "DEVELOPER") throw new ForbiddenException("This role cannot approve tests");
    const testCase = await this.prisma.testCase.findFirst({ where: { id: testCaseId, projectId } });
    if (!testCase) throw new NotFoundException("Test case not found");
    const latestAnalysis = await this.prisma.analysisRun.findFirst({ where: { projectId, status: "COMPLETED" }, orderBy: { completedAt: "desc" } });
    const updated = await this.prisma.testCase.update({
      where: { id: testCaseId },
      data: { status: "APPROVED", lastValidatedCommit: latestAnalysis?.commitSha ?? testCase.lastValidatedCommit },
      include: { modules: { include: { module: true } }, tags: { include: { tag: true } } }
    });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "test.approved", targetType: "TestCase", targetId: testCaseId });
    return updated;
  }

  async reject(user: AuthenticatedUser, projectId: string, testCaseId: string) {
    await this.assertProjectOwnership(user, projectId);
    if (user.role === "DEVELOPER") throw new ForbiddenException("This role cannot reject tests");
    const testCase = await this.prisma.testCase.findFirst({ where: { id: testCaseId, projectId } });
    if (!testCase) throw new NotFoundException("Test case not found");
    const updated = await this.prisma.testCase.update({ where: { id: testCaseId }, data: { status: "REJECTED" }, include: { modules: { include: { module: true } }, tags: { include: { tag: true } } } });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "test.rejected", targetType: "TestCase", targetId: testCaseId });
    return updated;
  }

  async bulkStatus(user: AuthenticatedUser, projectId: string, input: { testCaseIds: string[]; action: "approve" | "reject" | "archive" }) {
    await this.assertProjectOwnership(user, projectId);
    if (user.role === "DEVELOPER") throw new ForbiddenException("This role cannot change test statuses");
    const ids = [...new Set(input.testCaseIds)];
    if (!ids.length) throw new BadRequestException("At least one test case id is required");
    const status = input.action === "approve" ? "APPROVED" : input.action === "reject" ? "REJECTED" : "ARCHIVED";
    const result = await this.prisma.testCase.updateMany({ where: { id: { in: ids }, projectId }, data: { status } });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: `test.bulk_${input.action}`, targetType: "TestCase", metadata: { count: result.count } });
    return result;
  }

  async bulkClassify(user: AuthenticatedUser, projectId: string, input: { testCaseIds: string[]; addModuleIds?: string[]; removeModuleIds?: string[]; addTagIds?: string[]; removeTagIds?: string[]; moveModuleId?: string }) {
    await this.assertProjectOwnership(user, projectId);
    const ids = [...new Set(input.testCaseIds)];
    if (!ids.length) throw new BadRequestException("At least one test case id is required");
    const addModuleIds = [...new Set(input.addModuleIds ?? [])];
    const removeModuleIds = [...new Set(input.removeModuleIds ?? [])];
    const addTagIds = [...new Set(input.addTagIds ?? [])];
    const removeTagIds = [...new Set(input.removeTagIds ?? [])];
    await this.assertOrganizationClassifications(user.organizationId, [...addModuleIds, ...(input.moveModuleId ? [input.moveModuleId] : [])], addTagIds);

    if (input.moveModuleId) {
      await this.prisma.testModuleMembership.deleteMany({ where: { testCaseId: { in: ids }, module: { organizationId: user.organizationId } } });
      addModuleIds.unshift(input.moveModuleId);
    }
    await this.prisma.$transaction([
      ...(removeModuleIds.length ? [this.prisma.testModuleMembership.deleteMany({ where: { testCaseId: { in: ids }, moduleId: { in: removeModuleIds } } })] : []),
      ...addModuleIds.map((moduleId) => this.prisma.testModuleMembership.createMany({ data: ids.map((testCaseId) => ({ moduleId, testCaseId })), skipDuplicates: true })),
      ...(removeTagIds.length ? [this.prisma.testTagAssignment.deleteMany({ where: { testCaseId: { in: ids }, tagId: { in: removeTagIds } } })] : []),
      ...addTagIds.map((tagId) => this.prisma.testTagAssignment.createMany({ data: ids.map((testCaseId) => ({ tagId, testCaseId })), skipDuplicates: true }))
    ]);
    await recordAudit(this.prisma, {
      organizationId: user.organizationId, actorId: user.userId, action: "test.bulk_classified", targetType: "TestCase",
      metadata: { count: ids.length, addModuleIds, removeModuleIds, addTagIds, removeTagIds }
    });
    return { updated: ids.length };
  }

  /**
   * Delete a test case. Tests referenced by execution plans cannot be hard-deleted
   * (execution history is immutable), so they are archived instead.
   */
  async remove(user: AuthenticatedUser, projectId: string, testCaseId: string) {
    await this.assertProjectOwnership(user, projectId);
    if (user.role === "DEVELOPER") throw new ForbiddenException("This role cannot delete test cases");
    const test = await this.prisma.testCase.findFirst({ where: { id: testCaseId, projectId } });
    if (!test) throw new NotFoundException("Test case not found");
    const usage = await this.prisma.executionPlanItem.count({ where: { testCaseId } });
    if (usage > 0) {
      await this.prisma.testCase.update({ where: { id: testCaseId }, data: { status: "ARCHIVED" } });
      await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "test.archived_on_delete", targetType: "TestCase", targetId: testCaseId, metadata: { executions: usage } });
      return { deleted: false, archived: true, executions: usage, message: "This test has execution history, so it was archived instead of permanently deleted." };
    }
    await this.prisma.testCase.delete({ where: { id: testCaseId } });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "test.deleted", targetType: "TestCase", targetId: testCaseId });
    return { deleted: true, message: "Test case permanently deleted." };
  }

  async bulkDelete(user: AuthenticatedUser, projectId: string, testCaseIds: string[]) {
    await this.assertProjectOwnership(user, projectId);
    if (user.role === "DEVELOPER") throw new ForbiddenException("This role cannot delete test cases");
    const ids = [...new Set(testCaseIds)];
    if (!ids.length) throw new BadRequestException("At least one test case id is required");
    let deleted = 0;
    let archived = 0;
    for (const testCaseId of ids) {
      const usage = await this.prisma.executionPlanItem.count({ where: { testCaseId } });
      if (usage > 0) {
        await this.prisma.testCase.updateMany({ where: { id: testCaseId, projectId }, data: { status: "ARCHIVED" } });
        archived += 1;
      } else {
        try {
          await this.prisma.testCase.delete({ where: { id: testCaseId } });
          deleted += 1;
        } catch {
          await this.prisma.testCase.updateMany({ where: { id: testCaseId, projectId }, data: { status: "ARCHIVED" } });
          archived += 1;
        }
      }
    }
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "test.bulk_deleted", targetType: "TestCase", metadata: { deleted, archived } });
    return { deleted, archived, message: archived > 0 ? `${deleted} deleted, ${archived} archived (they have execution history that must be retained).` : `${deleted} test cases permanently deleted.` };
  }

  private buildDefinition(input: CreateManualInput) {
    const definition: unknown = {
      title: input.title.trim(),
      capability: input.capability?.trim() || input.title.trim(),
      category: this.pickCategory(input.category),
      preconditions: input.preconditions?.map((item) => item.trim()).filter(Boolean) ?? [],
      steps: input.steps ?? [],
      expectedResult: input.expectedResult?.trim() || "The application behaves as described.",
      tags: []
    };
    validateTestDefinition(definition);
    return definition as TestDefinition;
  }

  private pickCategory(category?: string) {
    if (!category) return "HAPPY_PATH";
    const upper = category.toUpperCase();
    return categories.includes(upper) ? upper : "HAPPY_PATH";
  }

  private pickPriority(priority?: string): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
    if (!priority) return "MEDIUM";
    const upper = priority.toUpperCase();
    return priorities.includes(upper) ? upper as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" : "MEDIUM";
  }

  private async assertProjectOwnership(user: AuthenticatedUser, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
  }

  private async assertOrganizationClassifications(organizationId: string, moduleIds: string[], tagIds: string[]) {
    const [modules, tags] = await Promise.all([
      moduleIds.length ? this.prisma.testModule.count({ where: { id: { in: moduleIds }, organizationId } }) : Promise.resolve(0),
      tagIds.length ? this.prisma.testTag.count({ where: { id: { in: tagIds }, organizationId } }) : Promise.resolve(0)
    ]);
    if (modules !== moduleIds.length || tags !== tagIds.length) throw new BadRequestException("A selected module or tag is not owned by this organization");
  }
}
