import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createDecipheriv, createHash } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { recordAudit } from "../common/audit";
import { assertBillingActive, assertQuota, recordUsage, subscriptionContext } from "../common/billing-context";
import { OpenAiCompatibleModelProvider, type ModelProvider } from "@ai-qa/model-provider";
import { validateTestDefinition, type TestDefinition } from "@ai-qa/test-dsl";
import { discoverLiveApp, type DiscoveredPage as CrawledPage } from "../analysis/live-discovery";

interface RouteInfo { path: string; page: string; feature: string }
interface DiscoveredPage { url: string; route?: string; title: string; navItems: string[]; buttons: string[]; inputs: string[]; headings: string[] }
interface KnowledgeModel {
  framework?: string;
  routes?: RouteInfo[];
  components?: string[];
  reachableComponents?: string[];
  discoveredPages?: DiscoveredPage[];
  discoveryError?: string;
  apiCalls?: string[];
  capabilities?: string[];
  analyzedFiles?: string[];
}

export interface CandidateDraft {
  title: string;
  capability: string;
  category: TestDefinition["category"];
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  route?: string;
  module?: string;
  tags?: string[];
  confidence: number;
  preconditions: string[];
  steps: Array<{ action: string; target: string; value?: string; condition?: string }>;
  expectedResult: string;
}

@Injectable()
export class GenerationsService {
  private readonly logger = new Logger(GenerationsService.name);
  constructor(private readonly prisma: PrismaService) {}

  async request(user: AuthenticatedUser, projectId: string, input: { targetCommit?: string; baseCommit?: string; mode?: "INCREMENTAL" | "FULL" }) {
    if (user.role === "DEVELOPER") throw new ForbiddenException("This role cannot generate tests");
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    const context = await subscriptionContext(this.prisma, user.organizationId);
    assertBillingActive(context, "Test generation");

    const lastCompleted = await this.prisma.analysisRun.findFirst({ where: { projectId, status: "COMPLETED" }, orderBy: { completedAt: "desc" } });
    const mode = input.mode === "FULL" ? "FULL" : "INCREMENTAL";
    if (mode === "INCREMENTAL" && !lastCompleted) throw new BadRequestException("Run a repository analysis before incremental generation");
    if (mode === "FULL" && !lastCompleted) throw new BadRequestException("Run a repository analysis before generating tests");

    // Incremental compares the last analyzed commit with the current branch head; full regeneration reuses
    // the same analysis pipeline but flags the run so the caller may re-analyze first.
    const targetCommit = input.targetCommit ?? lastCompleted!.commitSha;
    const baseCommit = mode === "INCREMENTAL" ? (input.baseCommit ?? lastCompleted!.commitSha) : input.baseCommit ?? undefined;

    const run = await this.prisma.generationRun.create({
      data: { organizationId: user.organizationId, projectId, baseCommit, targetCommit, mode, status: "RUNNING" }
    });
    await recordAudit(this.prisma, {
      organizationId: user.organizationId, actorId: user.userId, action: `generation.${mode.toLowerCase()}_requested`,
      targetType: "GenerationRun", targetId: run.id, metadata: { targetCommit, baseCommit }
    });
    return run;
  }

  list(user: AuthenticatedUser, projectId: string) {
    return this.prisma.generationRun.findMany({ where: { organizationId: user.organizationId, projectId }, orderBy: { createdAt: "desc" } });
  }

  async generateCandidates(user: AuthenticatedUser, projectId: string) {
    if (user.role === "DEVELOPER") throw new ForbiddenException("This role cannot generate tests");
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    const context = await subscriptionContext(this.prisma, user.organizationId);
    assertBillingActive(context, "Test generation");

    const analysis = await this.prisma.analysisRun.findFirst({ where: { organizationId: user.organizationId, projectId, status: "COMPLETED" }, orderBy: { completedAt: "desc" } });
    if (!analysis?.knowledgeModel) throw new BadRequestException("Analyze the repository before generating test cases");

    // Freshness gate: an old context silently degrades generation quality.
    const STALE_DAYS = 7;
    const ageDays = (Date.now() - analysis.createdAt.getTime()) / 86_400_000;
    if (ageDays > STALE_DAYS) {
      throw new BadRequestException(`The repository context is stale (analyzed ${Math.floor(ageDays)} days ago). Re-run Analyze to refresh routes and page controls, then generate again.`);
    }

    // Targeted rediscovery: if the knowledge model has no crawled pages (older
    // analysis format), crawl now so prompts stay grounded in the real UI.
    const knowledgeModel = analysis.knowledgeModel as unknown as KnowledgeModel;
    if (!(knowledgeModel.discoveredPages?.length)) {
      const environment = await this.prisma.environmentProfile.findFirst({ where: { projectId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
      if (environment?.url) {
        this.logger.log(`No discovered pages on the latest analysis — crawling ${environment.url}`);
        const routePaths = (knowledgeModel.routes ?? []).map((route) => route.path).filter((path) => path && path !== "*");
        const discovery = await discoverLiveApp(environment.url.replace(/\/$/, ""), routePaths);
        if (discovery.pages.length) knowledgeModel.discoveredPages = discovery.pages;
      }
    }

    const run = await this.prisma.generationRun.create({
      data: { organizationId: user.organizationId, projectId, baseCommit: analysis.commitSha, targetCommit: analysis.commitSha, mode: "INCREMENTAL", status: "RUNNING" }
    });

    const targets = this.buildTargets(knowledgeModel);
    if (!targets.length) {
      await this.prisma.generationRun.update({ where: { id: run.id }, data: { status: "COMPLETED", completedAt: new Date(), created: 0, duplicatesSkipped: 0 } });
      return { generationId: run.id, created: 0, duplicatesSkipped: 0, analysisCommit: analysis.commitSha, provider: "none" };
    }

    const provider = await this.resolveProvider();
    const estimatedTokens = this.estimateTokens(targets, Boolean(provider.impl));
    assertQuota(context, estimatedTokens, "Test generation");

    let providerFallbackDetail: string | undefined;
    try {
      let drafts: CandidateDraft[];
      let providerNote = provider.name;
      if (provider.impl) {
        try {
          drafts = await this.providerCandidates(provider.impl, provider.name, provider.model, targets, knowledgeModel);
        } catch (providerError) {
          // Provider outage, rate limit, or exhausted credits: fall back to template
          // candidates so regeneration still produces reviewable work instead of failing.
          const detail = providerError instanceof Error ? providerError.message : "provider unavailable";
          this.logger.warn(`Model provider failed (${detail}); falling back to template candidates`);
          drafts = this.heuristicCandidates(targets);
          providerNote = `${provider.name} (unavailable — template fallback used)`;
          providerFallbackDetail = detail;
        }
      } else {
        drafts = this.heuristicCandidates(targets);
      }

      const validDrafts = drafts
        .map((draft) => {
          try { return this.sanitizeDraft(draft); } catch { return null; }
        })
        .filter((draft): draft is CandidateDraft => draft !== null);

      const existing = await this.prisma.testCase.findMany({ where: { projectId }, select: { title: true } });
      const seen = new Set(existing.map((testCase) => this.normalizeTitle(testCase.title)));
      const fresh: CandidateDraft[] = [];
      let duplicates = 0;
      for (const draft of validDrafts) {
        const key = this.normalizeTitle(draft.title);
        if (seen.has(key)) { duplicates += 1; continue; }
        seen.add(key);
        fresh.push(draft);
      }

      const routeFeatures = new Map((knowledgeModel.routes ?? []).map((route) => [route.path, route.feature]));
      for (const draft of fresh) if (!draft.module && draft.route) draft.module = routeFeatures.get(draft.route);
      if (fresh.length) {
        await this.prisma.testCase.createMany({
          data: fresh.map((draft) => ({
            projectId,
            title: draft.title,
            status: "PENDING_REVIEW",
            source: "ANALYSIS_GENERATED",
            capability: draft.capability,
            category: draft.category,
            priority: draft.priority,
            confidence: draft.confidence,
            route: draft.route,
            generatedFromCommit: analysis.commitSha,
            lastValidatedCommit: analysis.commitSha,
            definition: { capability: draft.capability, category: draft.category, preconditions: draft.preconditions, steps: draft.steps, expectedResult: draft.expectedResult, tags: ["generated"] } as never
          }))
        });
        for (const draft of fresh) {
          const created = await this.prisma.testCase.findFirst({ where: { projectId, title: draft.title }, select: { id: true } });
          if (!created) continue;
          await this.prisma.testCaseVersion.create({ data: { testCaseId: created.id, version: 1, title: draft.title, definition: { capability: draft.capability, category: draft.category, preconditions: draft.preconditions, steps: draft.steps, expectedResult: draft.expectedResult } as never, note: `Generated from analysis ${analysis.commitSha.slice(0, 7)}` } });
          await this.assignClassifications(created.id, draft, user);
        }
      }

      let modulesAssigned = 0;
      if (provider.impl) {
        try {
          modulesAssigned = await this.classifyUnassigned(provider.impl, user, projectId);
        } catch (classifyError) {
          this.logger.warn(`Existing-test classification skipped: ${classifyError instanceof Error ? classifyError.message : classifyError}`);
        }
      }
      const providerName = provider.name;
      const providerModel = "model" in provider ? provider.model : "template";
      const consumed = providerName === "heuristic" ? 0 : estimatedTokens;
      await recordUsage(this.prisma, {
        organizationId: user.organizationId, projectId, generationRunId: run.id,
        provider: providerName, model: providerModel,
        inputTokens: providerName === "heuristic" ? 0 : Math.floor(consumed * 0.7),
        outputTokens: providerName === "heuristic" ? 0 : consumed - Math.floor(consumed * 0.7)
      });
      await this.prisma.generationRun.update({
        where: { id: run.id },
        data: { status: "COMPLETED", completedAt: new Date(), estimatedTokens, consumedTokens: consumed, created: fresh.length, duplicatesSkipped: duplicates }
      });
      await recordAudit(this.prisma, {
        organizationId: user.organizationId, actorId: user.userId, action: "generation.completed",
        targetType: "GenerationRun", targetId: run.id, metadata: { created: fresh.length, duplicates, provider: providerName, ...(providerFallbackDetail ? { providerFallback: providerFallbackDetail } : {}) }
      });
      return { generationId: run.id, created: fresh.length, duplicatesSkipped: duplicates, modulesAssigned, analysisCommit: analysis.commitSha, provider: providerName, ...(providerFallbackDetail ? { providerFallback: providerFallbackDetail } : {}) };
    } catch (error) {
      await this.prisma.generationRun.update({ where: { id: run.id }, data: { status: "FAILED", completedAt: new Date(), errorMessage: error instanceof Error ? error.message : "Generation failed" } });
      throw error;
    }
  }

  /** LLM output is untrusted: coerce categories, priorities, steps and confidence into valid shapes. */
  private sanitizeDraft(raw: CandidateDraft): CandidateDraft | null {
    const title = String(raw?.title ?? "").trim();
    if (!title) return null;
    const knownActions = ["navigate", "click", "fill", "select", "upload", "assert", "waitfor"];
    const steps = (Array.isArray(raw.steps) ? raw.steps : [])
      .map((step) => ({
        action: String(step?.action ?? "").toLowerCase().trim(),
        target: this.normalizeStepTarget(String(step?.target ?? "").trim()),
        ...(step?.value !== undefined && step?.value !== null && String(step.value) !== "" ? { value: String(step.value) } : {}),
        ...(step?.condition !== undefined && step?.condition !== null && String(step.condition) !== "" ? { condition: String(step.condition).toLowerCase().trim() } : {})
      }))
      .filter((step) => knownActions.includes(step.action) && step.target)
      .map((step) => ({ ...step, action: step.action === "waitfor" ? "waitFor" : step.action }));
    if (!steps.length) return null;
    return {
      title,
      capability: String(raw.capability ?? title).trim() || title,
      category: this.normalizeCategory(raw.category),
      priority: this.normalizePriority(raw.priority),
      route: raw.route ? String(raw.route).trim() : undefined,
      module: this.normalizeModuleName(raw.module),
      tags: this.normalizeTags(raw.tags).length ? this.normalizeTags(raw.tags) : undefined,
      confidence: this.clampConfidence(raw.confidence),
      preconditions: Array.isArray(raw.preconditions) ? raw.preconditions.map((line) => String(line).trim()).filter(Boolean) : [],
      steps,
      expectedResult: String(raw.expectedResult ?? "").trim() || "The application behaves as described."
    };
  }

  /**
   * The model sometimes writes instructions into targets ("click on DECORATION
   * Stepper"). Reduce them to the bare element name; URLs pass through as-is.
   */
  /**
   * Idea 1: plain-English flow -> AI-drafted TestDefinition, grounded in the
   * latest analysis knowledge model (routes + discovered real controls).
   * Draft only — the caller reviews it in the editor before saving.
   */
  async aiDraft(user: AuthenticatedUser, projectId: string, description: string) {
    if (!description?.trim()) throw new BadRequestException("description is required");
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    const analysis = await this.prisma.analysisRun.findFirst({ where: { organizationId: user.organizationId, projectId, status: "COMPLETED" }, orderBy: { completedAt: "desc" } });
    if (!analysis?.knowledgeModel) throw new BadRequestException("Run Analyze on the repository first — the AI needs the app context to draft steps.");
    const model = analysis.knowledgeModel as unknown as KnowledgeModel;

    const provider = await this.resolveProvider();
    if (!provider.impl) throw new BadRequestException("AI drafting needs an AI provider. Set OPENAI_API_KEY (+ OPENAI_MODEL) in the environment, or configure a provider in the admin console.");

    // pick the pages most relevant to the description by keyword overlap
    const words = description.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
    const scorePage = (page: DiscoveredPage) => {
      const haystack = [page.route, page.title, ...page.buttons, ...page.inputs, ...page.headings, ...page.navItems].join(" ").toLowerCase();
      return words.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0);
    };
    const pages = [...(model.discoveredPages ?? [])].sort((a, b) => scorePage(b) - scorePage(a)).slice(0, 3);

    const routeList = (model.routes ?? []).filter((route) => route.path !== "*").map((route) => ({ path: route.path, feature: route.feature }));
    const systemPrompt = [
      "You convert a plain-English test description into ONE structured Playwright-style test case.",
      "Return ONLY a JSON object: {\"title\",\"capability\",\"category\",\"priority\",\"route\",\"preconditions\":[string],\"steps\":[{\"action\",\"target\",\"value?\",\"condition?\"}],\"expectedResult\",\"module\",\"tags\":[string]}.",
      "Choose \"route\" from the provided route list (the page where the flow happens).",
      "The optional \"pageControls\" for that route list REAL buttons/inputs verified on the deployed app — use those exact labels as click/fill targets when they fit. Never invent elements outside them unless the description clearly names something else.",
      "categories: HAPPY_PATH|NEGATIVE|BOUNDARY|VALIDATION|PERMISSION|ERROR|STATE|INTEGRATION. priorities: CRITICAL|HIGH|MEDIUM|LOW.",
      "THE DESCRIPTION IS THE SPECIFICATION: include EVERY action it describes, in its exact order. Do not drop, merge, summarize, or skip any step — including opening modals, selecting items, clicking apply buttons, and the final verification the description asks for.",
      "There is NO step limit — a long flow gets a long test.",
      "If the description ends with a check (e.g. 'verify X is flipped / visible / loaded'), the LAST step MUST be an assert that verifies it."
    ].join(" ");
    const prompt = JSON.stringify({
      description: description.slice(0, 2_000),
      routes: routeList,
      pageControls: pages.length ? pages.map((page) => ({ route: page.route, buttons: page.buttons, inputs: page.inputs, headings: page.headings })) : undefined
    }).slice(0, 14_000);

    const response = await provider.impl.generateStructured<Partial<CandidateDraft>>({
      organizationId: user.organizationId, projectId, jobId: "ai-draft",
      capability: "test-generation",
      systemPrompt,
      prompt,
      schemaName: "TestDraft",
      schema: {}
    });

    const sanitized = this.sanitizeDraft({
      title: String(response.output?.title ?? description.slice(0, 80)),
      capability: response.output?.capability ?? "",
      category: response.output?.category ?? "HAPPY_PATH",
      priority: response.output?.priority ?? "MEDIUM",
      route: response.output?.route,
      confidence: response.output?.confidence ?? 0.8,
      preconditions: response.output?.preconditions ?? [],
      steps: response.output?.steps ?? [],
      expectedResult: response.output?.expectedResult ?? "",
      module: response.output?.module,
      tags: response.output?.tags
    });
    if (!sanitized) throw new BadRequestException("The AI could not produce a valid draft from that description — try adding the page or button names.");
    // Programmatic guarantees the model is inconsistent about: start on the
    // chosen route, and end with an explicit verification step.
    if (!sanitized.steps.some((step) => step.action === "navigate")) {
      if (sanitized.route) sanitized.steps.unshift({ action: "navigate", target: sanitized.route });
    }
    if (!sanitized.steps.some((step) => step.action === "assert")) {
      const subject = sanitized.capability || sanitized.title;
      sanitized.steps.push({ action: "assert", target: subject, condition: "visible" });
    }
    return { draft: sanitized };
  }

  private normalizeStepTarget(target: string): string {
    if (!target || /^[/?#]/.test(target) || /^https?:\/\//i.test(target)) return target;
    let cleaned = target;
    const prefix = cleaned.match(/^(?:cl+ick|tap|press|select|choose|go to|navigate to|open)\s+(?:on\s+|the\s+)?(.+)$/i);
    if (prefix) cleaned = prefix[1];
    cleaned = cleaned.replace(/\s+(?:stepper|button|link|tab|menu|option|from\s+sidebar)$/i, "");
    return cleaned.trim();
  }

  private normalizeCategory(value: unknown): CandidateDraft["category"] {
    const upper = String(value ?? "").toUpperCase().replace(/[\s-]+/g, "_");
    const known = ["HAPPY_PATH", "NEGATIVE", "BOUNDARY", "VALIDATION", "PERMISSION", "ERROR", "STATE", "INTEGRATION"];
    if (known.includes(upper)) return upper as CandidateDraft["category"];
    if (/ERROR|FAILURE|EXCEPTION/.test(upper)) return "ERROR";
    if (/PERMISSION|AUTH|ACCESS|ROLE/.test(upper)) return "PERMISSION";
    if (/BOUNDARY|EDGE|LIMIT/.test(upper)) return "BOUNDARY";
    if (/NEGATIVE|INVALID/.test(upper)) return "NEGATIVE";
    if (/VALIDATION|VALID|INPUT|FORM/.test(upper)) return "VALIDATION";
    if (/STATE|TRANSITION/.test(upper)) return "STATE";
    if (/INTEGRATION|API|SERVICE/.test(upper)) return "INTEGRATION";
    return "HAPPY_PATH";
  }

  private normalizePriority(value: unknown): CandidateDraft["priority"] {
    const upper = String(value ?? "").toUpperCase().replace(/[\s-]+/g, "_");
    if (/P0|BLOCKER|CRITICAL|CRIT/.test(upper)) return "CRITICAL";
    if (/P1|HIGH|MAJOR/.test(upper)) return "HIGH";
    if (/P2|MEDIUM|MED|NORMAL/.test(upper)) return "MEDIUM";
    if (/P3|LOW|MINOR|TRIVIAL/.test(upper)) return "LOW";
    return "MEDIUM";
  }

  private clampConfidence(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return 0.5;
    return num > 1 ? Math.min(1, num / 100) : Math.min(1, num);
  }

  private buildTargets(model: KnowledgeModel): Array<{ capability: string; route?: string; page?: DiscoveredPage }> {
    const discovered = model.discoveredPages ?? [];
    const targets: Array<{ capability: string; route?: string; page?: DiscoveredPage }> = [];
    for (const route of model.routes ?? []) {
      if (route.path === "*") continue;
      const page = discovered.find((entry) => entry.route === route.path)
        ?? discovered.find((entry) => entry.route !== undefined && entry.route !== "/" && route.path !== "/" && route.path.startsWith(entry.route));
      targets.push({ capability: route.feature, route: route.path, page });
    }
    for (const name of model.reachableComponents ?? []) {
      if (targets.length >= 24) break;
      if (!this.isFeatureWorthy(name) || targets.some((target) => target.capability === name)) continue;
      targets.push({ capability: name });
    }
    return targets;
  }

  /** Attach an AI-suggested module/tags to a freshly created test, creating the org-level module/tag when missing. */
  private async assignClassifications(testCaseId: string, draft: CandidateDraft, user: AuthenticatedUser) {
    if (draft.module) {
      const module = await this.findOrCreateModule(user.organizationId, draft.module, user.userId);
      if (module) await this.prisma.testModuleMembership.createMany({ data: { moduleId: module.id, testCaseId }, skipDuplicates: true });
    }
    for (const tagName of draft.tags ?? []) {
      const tag = await this.findOrCreateTag(user.organizationId, tagName, user.userId);
      if (tag) await this.prisma.testTagAssignment.createMany({ data: { tagId: tag.id, testCaseId }, skipDuplicates: true });
    }
  }

  /**
   * Organize existing AI-generated tests that have no module yet: batch their
   * titles to the model, get module + tags per test, and apply the memberships.
   */
  private async classifyUnassigned(impl: ModelProvider, user: AuthenticatedUser, projectId: string): Promise<number> {
    const unassigned = await this.prisma.testCase.findMany({
      where: { projectId, source: "ANALYSIS_GENERATED", modules: { none: {} } },
      select: { id: true, title: true, capability: true, category: true },
      take: 300
    });
    if (!unassigned.length) return 0;

    const systemPrompt = [
      "You organize a QA test suite by business module.",
      "Return ONLY a JSON object: {\"assignments\":[{\"id\",\"module\",\"tags\":[string]}]}.",
      "module: short Title Case business area grouping the test, e.g. 'Cart and Checkout', 'Authentication', 'Product Management', 'Color Selection', 'File Upload'. Use consistent, stable module names across the batch.",
      "tags: up to 3 lowercase labels from [smoke, critical, regression, forms, navigation, upload, auth, error-handling, e2e].",
      "Provide an assignment for EVERY test id in the input. Do not invent ids."
    ].join(" ");

    let assigned = 0;
    for (let index = 0; index < unassigned.length; index += 20) {
      const batch = unassigned.slice(index, index + 20);
      try {
        const response = await impl.generateStructured<{ assignments?: Array<{ id?: string; module?: string; tags?: string[] }> }>({
          organizationId: "", projectId: "", jobId: "classification",
          capability: "classification",
          systemPrompt,
          prompt: JSON.stringify({ tests: batch }),
          schemaName: "ModuleAssignments",
          schema: {}
        });
        for (const entry of response.output?.assignments ?? []) {
          if (!entry?.id) continue;
          const test = batch.find((item) => item.id === entry.id);
          if (!test) continue;
          const module = entry.module ? await this.findOrCreateModule(user.organizationId, entry.module, user.userId) : null;
          if (module) await this.prisma.testModuleMembership.createMany({ data: { moduleId: module.id, testCaseId: entry.id }, skipDuplicates: true });
          for (const tagName of this.normalizeTags(entry.tags)) {
            const tag = await this.findOrCreateTag(user.organizationId, tagName, user.userId);
            if (tag) await this.prisma.testTagAssignment.createMany({ data: { tagId: tag.id, testCaseId: entry.id }, skipDuplicates: true });
          }
          assigned += 1;
        }
      } catch (batchError) {
        this.logger.warn(`Classification batch failed: ${batchError instanceof Error ? batchError.message : batchError}`);
      }
    }
    if (assigned) {
      await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "generation.classified_existing", targetType: "TestCase", metadata: { assigned } });
    }
    return assigned;
  }

  private async findOrCreateModule(organizationId: string, name: string, actorId: string) {
    const clean = this.normalizeModuleName(name);
    if (!clean) return null;
    const existing = await this.prisma.testModule.findUnique({ where: { organizationId_name: { organizationId, name: clean } } });
    if (existing) return existing;
    try {
      const created = await this.prisma.testModule.create({ data: { organizationId, name: clean } });
      await recordAudit(this.prisma, { organizationId, actorId, action: "classification.module_auto_created", targetType: "TestModule", targetId: created.id, metadata: { name: clean, auto: true } });
      return created;
    } catch {
      return this.prisma.testModule.findUnique({ where: { organizationId_name: { organizationId, name: clean } } });
    }
  }

  private async findOrCreateTag(organizationId: string, name: string, actorId: string) {
    const clean = this.normalizeTagName(name);
    if (!clean) return null;
    const existing = await this.prisma.testTag.findUnique({ where: { organizationId_name: { organizationId, name: clean } } });
    if (existing) return existing;
    try {
      const created = await this.prisma.testTag.create({ data: { organizationId, name: clean } });
      await recordAudit(this.prisma, { organizationId, actorId, action: "classification.tag_auto_created", targetType: "TestTag", targetId: created.id, metadata: { name: clean, auto: true } });
      return created;
    } catch {
      return this.prisma.testTag.findUnique({ where: { organizationId_name: { organizationId, name: clean } } });
    }
  }

  private normalizeModuleName(value: unknown): string | undefined {
    const cleaned = String(value ?? "").replace(/[^a-zA-Z0-9 &/-]/g, " ").replace(/\s+/g, " ").trim()
      .split(" ").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ").slice(0, 40).trim();
    return cleaned && cleaned.length >= 3 ? cleaned : undefined;
  }

  private normalizeTags(value: unknown): string[] {
    const raw = Array.isArray(value) ? value : [];
    const seen = new Set<string>();
    for (const item of raw) {
      const slug = String(item ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
      if (slug && slug.length >= 3) seen.add(slug);
      if (seen.size >= 3) break;
    }
    return [...seen];
  }

  private normalizeTagName(value: unknown): string {
    return this.normalizeTags([value])[0] ?? "";
  }

  /**
   * Capability gate: the analyzer's regex picks up constants (BG_COLOR),
   * single letters, and generic layout wrappers as "components". Tests for
   * those are noise — keep names that plausibly map to user-facing features.
   */
  private isFeatureWorthy(name: string): boolean {
    const trimmed = name.trim();
    if (trimmed.length < 3) return false;
    if (/^[A-Z0-9_]+$/.test(trimmed)) return false; // SCREAMING_CASE constants
    if (/^use[A-Z]/.test(trimmed)) return false; // react hooks
    const generic = new Set(["App", "AppShell", "AppShellRoot", "Index", "Main", "Root", "Wrapper", "Container", "Layout", "Page", "ErrorBoundary", "Provider", "ThemeProvider", "AuthProvider", "BrowserRouter", "Routes", "Route"]);
    if (generic.has(trimmed)) return false;
    return true;
  }

  private heuristicCandidates(targets: Array<{ capability: string; route?: string }>): CandidateDraft[] {
    const drafts: CandidateDraft[] = [];
    type StepDraft = { action: "navigate" | "click" | "waitFor" | "assert"; target: string; value?: string; condition?: "visible" | "hidden" | "equals" | "contains" | "urlMatches" };
    const templates: Array<[string, string, (nav: { action: "navigate"; target: string } | null) => StepDraft[]]> = [
      ["happy path", "HAPPY_PATH", (nav) => [
        ...(nav ? [nav] : []),
        { action: "waitFor", target: "{capability}", condition: "visible" }
      ]],
      ["validation and error handling", "VALIDATION", (nav) => [
        ...(nav ? [nav] : []),
        { action: "click", target: "Submit" },
        { action: "assert", target: "Required", condition: "visible" }
      ]]
    ];
    for (const { capability, route } of targets) {
      const navigation = route ? { action: "navigate" as const, target: route } : null;
      for (const [suffix, category, buildSteps] of templates) {
        const steps: StepDraft[] = buildSteps(navigation).map((step) => ({ ...step, target: step.target.replace("{capability}", capability) }));
        drafts.push({
          title: `${capability}: ${suffix}`,
          capability,
          category: category as CandidateDraft["category"],
          priority: category === "HAPPY_PATH" ? "HIGH" : "MEDIUM",
          route,
          confidence: 0.55,
          preconditions: [route ? `The ${capability} page at ${route} is reachable` : `The ${capability} area is reachable`],
          steps,
          expectedResult: category === "HAPPY_PATH" ? `${capability} completes successfully and shows its primary content.` : `${capability} shows an actionable error state when input or a dependent request fails.`
        });
      }
    }
    return drafts;
  }

  private async providerCandidates(
    impl: ModelProvider,
    providerName: string,
    providerModel: string,
    targets: Array<{ capability: string; route?: string; page?: DiscoveredPage }>,
    model: KnowledgeModel
  ): Promise<CandidateDraft[]> {
    const systemPrompt = [
      "You are a senior QA engineer writing scenario-based Playwright tests for a React web application.",
      "Return ONLY a JSON object: {\"candidates\":[{\"title\",\"capability\",\"category\",\"priority\",\"route\",\"confidence\",\"preconditions\":[string],\"steps\":[{\"action\",\"target\",\"value?\",\"condition?\"}],\"expectedResult\",\"module\",\"tags\":[string]}]}.",
      "actions: navigate|click|fill|select|upload|assert|waitFor. conditions: visible|hidden|equals|contains|urlMatches.",
      "categories: HAPPY_PATH|NEGATIVE|BOUNDARY|VALIDATION|PERMISSION|ERROR|STATE|INTEGRATION. priorities: CRITICAL|HIGH|MEDIUM|LOW. confidence: 0-1.",
      "Each capability may carry a 'route' and a 'discovered' object captured from the LIVE deployed application. When present:",
      "- The FIRST step must be navigate with target = the route path (relative, no domain).",
      "- click/fill targets MUST use the exact discovered button labels and input placeholders/labels — they are verified to exist on the page. Never invent element names that are not in the discovered data.",
      "For EVERY capability write 3 tests with DIFFERENT categories:",
      "1. HAPPY_PATH: a complete user workflow (4-8 steps) exercising the feature end to end the way a real user would.",
      "2. VALIDATION or NEGATIVE: invalid/empty/malformed input and the specific expected behavior.",
      "3. ERROR, BOUNDARY, STATE, PERMISSION, or INTEGRATION \u2014 whichever genuinely applies.",
      "Every candidate must include \"module\": the business area in short Title Case (e.g. 'Cart and Checkout', 'Authentication', 'Summary'), consistent across candidates. And \"tags\": up to 3 lowercase labels from [smoke, critical, regression, forms, navigation, upload, auth, error-handling, e2e].",
      "Titles must describe the scenario ('Create product and verify it appears in catalog'), not the category. At most 8 steps."
    ].join(" ");

    // Batched: small groups keep outputs well-formed and limit blast radius.
    const batchSize = 6;
    const batches: Array<typeof targets> = [];
    for (let index = 0; index < targets.length; index += batchSize) batches.push(targets.slice(index, index + batchSize));

    const all: CandidateDraft[] = [];
    let failedBatches = 0;
    for (const batch of batches) {
      const prompt = JSON.stringify({
        application: { framework: model.framework },
        capabilities: batch.map((target) => ({
          capability: target.capability,
          route: target.route,
          discovered: target.page ? {
            pageTitle: target.page.title,
            navItems: target.page.navItems,
            buttons: target.page.buttons,
            inputs: target.page.inputs,
            headings: target.page.headings
          } : undefined
        }))
      }).slice(0, 14_000);
      try {
        const response = await impl.generateStructured<{ candidates?: CandidateDraft[] }>({
          organizationId: "", projectId: "", jobId: "generation",
          capability: "test-generation",
          systemPrompt,
          prompt,
          schemaName: "CandidateList",
          schema: {}
        });
        all.push(...(Array.isArray(response.output?.candidates) ? response.output.candidates : []));
      } catch (batchError) {
        failedBatches += 1;
        this.logger.warn(`Generation batch failed (${batchError instanceof Error ? batchError.message : batchError}); continuing with ${batches.length - failedBatches} remaining`);
      }
    }
    if (!all.length) throw new Error(`all ${failedBatches} generation batches failed`);
    void providerName;
    void providerModel;
    return all;
  }

  private async resolveProvider(): Promise<{ name: string; model: string; impl: ModelProvider | null }> {
    const config = await this.prisma.aiProviderConfig.findFirst({ where: { enabled: true, isPrimary: true } }) ?? await this.prisma.aiProviderConfig.findFirst({ where: { enabled: true } });
    const baseUrl = config?.baseUrl ?? (process.env.OPENAI_API_KEY ? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1" : undefined);
    const apiKey = config?.apiKeyCiphertext ? this.decryptKey(config.apiKeyCiphertext, config.apiKeyIv!, config.apiKeyTag!) : process.env.OPENAI_API_KEY || undefined;
    const model = config?.model ?? process.env.OPENAI_MODEL;
    if (baseUrl && apiKey && model) {
      const impl = new OpenAiCompatibleModelProvider({ baseUrl, apiKey, model, providerName: config?.name ?? "openai" });
      return { name: config?.name ?? "openai", model, impl };
    }
    return { name: "heuristic", model: "template", impl: null };
  }

  private decryptKey(ciphertext: string, iv: string, tag: string) {
    const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(process.env.JWT_SECRET ?? "").digest(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  }

  private estimateTokens(targets: Array<{ capability: string; route?: string }>, realProvider: boolean) {
    if (!realProvider) return 0;
    return targets.length * 1_200;
  }

  private normalizeTitle(title: string) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
}
