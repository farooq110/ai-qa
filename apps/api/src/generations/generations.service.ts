import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { recordAudit } from "../common/audit";
import { assertBillingActive, assertQuota, subscriptionContext } from "../common/billing-context";
import type { ModelProvider } from "@ai-qa/model-provider";
import { resolveModelProvider } from "../common/model-provider";
import { firstFixtures, isAuthRoute, isNoiseText, matchesApiCall, parseResponseRule, validateTestDefinition, type TestDefinition } from "@ai-qa/test-dsl";
import { discoverLiveApp, discoveryAuth, type ControlBehavior, type DiscoveredPage } from "../analysis/live-discovery";
import type { RouteInfo } from "../analysis/analyzer";
import { PermissionsService } from "../rbac/permissions.service";
import { PERMISSIONS } from "@ai-qa/domain";
import { loadSessionState, sessionStore } from "../common/environment-session";
import { enqueueGeneration, enqueueSpecGeneration, enqueueSpecWaveB, enqueueVerification } from "../common/queue";
import { UsageLedger } from "../common/usage-ledger";
import type { FlowSpecData } from "@ai-qa/contracts";
import { planScenarios, type ModuleSpec, type PlannedScenario } from "./planner";
import { alignToAction, buildSpecEvidence, touchesTrigger, scenarioPromptPayload, SPEC_GENERATOR_SYSTEM_PROMPT, type SpecDraft } from "./spec-generator";

interface CodeSummary {
  component: string;
  file: string;
  renderedElements: Array<{ kind: string; label: string; onClickHandler?: string }>;
  handlers: Array<{ handler: string; apiCalls: string[]; navigations: string[] }>;
}
interface KnowledgeModel {
  framework?: string;
  routes?: RouteInfo[];
  components?: string[];
  reachableComponents?: string[];
  discoveredPages?: DiscoveredPage[];
  codeContext?: CodeSummary[];
  loginStatus?: "none" | "ok" | "failed";
  discoveryError?: string;
  apiCalls?: string[];
  capabilities?: string[];
  analyzedFiles?: string[];
  /** Phase 4/5: one FlowSpecData per module, already anchored, plus the endpoint rows its calls join to. */
  flowSpecs?: Array<{ moduleKey: string; name: string; spec: FlowSpecData; stats: { facts: number; dropped: string[] }; cached: boolean }>;
  endpoints?: Array<{ id: string; method: string; fullPath: string; norm: string }>;
}

/** One page the model may write tests for: only pages with real, verified controls become targets. */
interface Target {
  capability: string; route: string; url: string; page?: DiscoveredPage; code: CodeSummary[];
  /** Tests the model may write for this page: scaled to how much there is to test. */
  maxTests: number;
  label?: string;
  apiCalls?: string[];
}

/** More forms, inputs and actions on a page = more distinct scenarios worth a test. */
export function testBudget(page: Pick<DiscoveredPage, "buttons" | "inputs" | "selects" | "clickables"> | undefined, auth: boolean): number {
  if (auth) return 1;
  if (!page) return 2;
  const fields = page.inputs.length + page.selects.length;
  return Math.min(5, 2 + (fields >= 1 ? 1 : 0) + (fields >= 4 ? 1 : 0) + (page.buttons.length + page.clickables.length >= 10 ? 1 : 0));
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
  steps: Array<{ action: string; target: string; value?: string; condition?: string; key?: boolean; role?: string; within?: string }>;
  expectedResult: string;
}

// ponytail: activity-based guess (matches the web UI's stale window); a heartbeat column would be exact.
const STALE_RUN_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class GenerationsService {
  private readonly logger = new Logger(GenerationsService.name);
  constructor(private readonly prisma: PrismaService, private readonly permissions: PermissionsService) {}

  private latestAnalysis(organizationId: string, projectId: string) {
    return this.prisma.analysisRun.findFirst({ where: { organizationId, projectId, status: "COMPLETED" }, orderBy: { completedAt: "desc" } });
  }

  /**
   * The project's default environment and the pages a draft may be grounded on (the Route Map, else the
   * analysis snapshot). Values the crawl proved for path parameters are saved where the runner reads
   * {{param}} fixtures (never over user-entered ones) - without them placeholders reach the browser verbatim.
   */
  private async environmentTargets(projectId: string, knowledgeModel: KnowledgeModel) {
    const environment = await this.prisma.environmentProfile.findFirst({ where: { projectId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
    const envFixtures = firstFixtures(environment?.routeFixtures);
    const mapped = await this.routeTargets(projectId, envFixtures, knowledgeModel);
    if (mapped && environment && Object.keys(mapped.autoFixtures).length) {
      // The saved values win (kept as saved, lists included); auto-filled ones only fill routes with none.
      await this.prisma.environmentProfile.update({ where: { id: environment.id }, data: { routeFixtures: { ...mapped.autoFixtures, ...((environment.routeFixtures ?? {}) as object) } as never } });
    }
    const { targets, skipped } = mapped ?? this.buildTargets(knowledgeModel, envFixtures);
    return { environment, targets, skipped };
  }

  /**
   * One generation at a time per project: two runs drafting the same scenarios collide on scenarioKey.
   * A run with no test activity for STALE_RUN_MS lost its job (a crashed process, a vanished queue
   * entry); it is failed here so it can never lock Generate for good.
   */
  private async activeRun(projectId: string) {
    const run = await this.prisma.generationRun.findFirst({ where: { projectId, status: { in: ["QUEUED", "RUNNING"] } }, orderBy: { createdAt: "desc" } });
    if (!run) return null;
    const lastTest = await this.prisma.testCase.findFirst({ where: { generationRunId: run.id }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } });
    const lastActivity = Math.max(run.createdAt.getTime(), lastTest?.updatedAt.getTime() ?? 0);
    if (Date.now() - lastActivity < STALE_RUN_MS) return run;
    await this.prisma.generationRun.updateMany({ where: { id: run.id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", completedAt: new Date(), errorMessage: "Generation stopped making progress and was abandoned. Generate again." } });
    return null;
  }

  list(user: AuthenticatedUser, projectId: string) {
    return this.prisma.generationRun.findMany({ where: { organizationId: user.organizationId, projectId }, orderBy: { createdAt: "desc" } });
  }

  async get(user: AuthenticatedUser, projectId: string, generationId: string) {
    const run = await this.prisma.generationRun.findFirst({ where: { id: generationId, organizationId: user.organizationId, projectId } });
    if (!run) throw new NotFoundException("Generation run not found");
    return run;
  }

  /** Validates fast, queues the real work, and returns immediately - the UI polls GET :generationId. */
  async generateCandidates(user: AuthenticatedUser, projectId: string) {
    await this.permissions.assert(user, PERMISSIONS.TEST_CASES_CREATE);
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    const context = await subscriptionContext(this.prisma, user.organizationId);
    assertBillingActive(context, "Test generation");
    const active = await this.activeRun(projectId);
    if (active) return { generationId: active.id }; // the UI keeps polling the run already in progress

    const analysis = await this.latestAnalysis(user.organizationId, projectId);
    if (!analysis?.knowledgeModel) throw new BadRequestException("Analyze the repository before generating test cases");

    // Freshness gate: an old context silently degrades generation quality.
    const STALE_DAYS = 7;
    const ageDays = (Date.now() - analysis.createdAt.getTime()) / 86_400_000;
    if (ageDays > STALE_DAYS) {
      throw new BadRequestException(`The repository context is stale (analyzed ${Math.floor(ageDays)} days ago). Re-run Analyze to refresh routes and page controls, then generate again.`);
    }
    // Flow specs with real actions mean the spec-grounded planner can run; the crawl-only path below
    // is the fallback for apps where spec extraction found nothing to act on.
    const flowSpecs = (analysis.knowledgeModel as unknown as KnowledgeModel).flowSpecs ?? [];
    if (flowSpecs.some((entry) => entry.spec.actions.length)) return this.generateSpecCandidates(user, projectId);
    // A cheap floor check before queuing; the real cost (once targets are known) is re-checked in runGeneration.
    assertQuota(context, 20_000, "Test generation");

    const run = await this.prisma.generationRun.create({
      data: { organizationId: user.organizationId, projectId, baseCommit: analysis.commitSha, targetCommit: analysis.commitSha, mode: "INCREMENTAL", status: "QUEUED" }
    });
    await enqueueGeneration(run.id);
    return { generationId: run.id };
  }

  /** The actual generation work, run as a background job (see GENERATIONS_QUEUE / generation.processor.ts). */
  async runGeneration(runId: string): Promise<void> {
    const run = await this.prisma.generationRun.findUnique({ where: { id: runId }, include: { project: true } });
    if (!run || run.status !== "QUEUED") return;
    await this.prisma.generationRun.update({ where: { id: runId }, data: { status: "RUNNING" } });
    const { project, projectId, organizationId } = run;

    try {
      const analysis = await this.latestAnalysis(organizationId, projectId);
      if (!analysis?.knowledgeModel) throw new BadRequestException("Analyze the repository before generating test cases");
      const context = await subscriptionContext(this.prisma, organizationId);

      // Targeted rediscovery: if the knowledge model has no crawled pages (older
      // analysis format), crawl now so prompts stay grounded in the real UI.
      const knowledgeModel = analysis.knowledgeModel as unknown as KnowledgeModel;
      const environment = await this.prisma.environmentProfile.findFirst({ where: { projectId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
      if (!(knowledgeModel.discoveredPages?.length) && environment?.url) {
        this.logger.log(`No discovered pages on the latest analysis — crawling ${environment.url}`);
        const routePaths = (knowledgeModel.routes ?? []).map((route) => route.path).filter((path) => path && path !== "*");
        const discovery = await discoverLiveApp(environment.url.replace(/\/$/, ""), routePaths, { auth: discoveryAuth(environment), sessionState: loadSessionState(environment), sessionStore: sessionStore(this.prisma, environment.id) });
        if (discovery.pages.length) knowledgeModel.discoveredPages = discovery.pages;
        knowledgeModel.loginStatus = discovery.login;
      }

      const { targets, skipped } = await this.environmentTargets(projectId, knowledgeModel);
      if (!targets.length) {
        // Nothing to draft from — say why instead of "completing" with 0 tests.
        const scope = project.rootDirectory ? `${project.repoFullName}/${project.rootDirectory}` : project.repoFullName;
        const message = skipped.length
          ? `No page could be grounded in the real app, so no tests were drafted:\n${skipped.map((line) => `- ${line}`).join("\n")}`
          : `Analysis found no pages in ${scope}. Proofline reads React Router and Next.js routes. In a monorepo, import the repository again with the app's folder as the root directory (e.g. apps/web).`;
        await this.prisma.generationRun.update({ where: { id: runId }, data: { status: "FAILED", completedAt: new Date(), created: 0, duplicatesSkipped: 0, errorMessage: message, report: { stage: "failed", skipped: skipped.map((reason) => ({ reason })) } as never } });
        return;
      }

      await this.consolidateModules(organizationId).catch(() => 0);
      const existingModules = (await this.prisma.testModule.findMany({ where: { organizationId }, select: { name: true }, take: 60 })).map((module) => module.name);
      const provider = await this.resolveProvider();
      const estimatedTokens = this.estimateTokens(targets, Boolean(provider.impl));
      assertQuota(context, estimatedTokens, "Test generation");
      const ledger = new UsageLedger();

      let providerFallbackDetail: string | undefined;
      let drafts: CandidateDraft[];
      const providerName = provider.name;
      if (provider.impl) {
        try {
          drafts = await this.providerCandidates(provider.impl, provider.name, provider.model, targets, knowledgeModel, Boolean(environment?.usernameEnc && environment?.passwordEnc), existingModules, ledger);
        } catch (providerError) {
          // Provider outage, rate limit, or exhausted credits: fall back to template
          // candidates so regeneration still produces reviewable work instead of failing.
          const detail = providerError instanceof Error ? providerError.message : "provider unavailable";
          this.logger.warn(`Model provider failed (${detail}); falling back to template candidates`);
          drafts = this.smokeCandidates(targets);
          providerFallbackDetail = detail;
        }
      } else {
        drafts = this.smokeCandidates(targets);
      }

      const validDrafts: CandidateDraft[] = [];
      const ungrounded: string[] = [];
      for (const draft of drafts) {
        let clean: CandidateDraft | null = null;
        try { clean = this.sanitizeDraft(draft); } catch { /* malformed model output */ }
        if (!clean) continue;
        const outcome = this.groundDraft(clean, targets, knowledgeModel);
        if (typeof outcome === "string") { ungrounded.push(`${clean.title} — ${outcome}`); continue; }
        validDrafts.push(outcome);
      }
      // Weighting: per-page budget, and auth pages never crowd out the business pages.
      const perRoute = new Map<string, number>();
      let authKept = 0;
      for (const draft of [...validDrafts].sort((a, b) => b.confidence - a.confidence)) {
        const target = targets.find((entry) => entry.route === draft.route);
        const used = perRoute.get(draft.route ?? "") ?? 0;
        const auth = isAuthRoute(draft.route ?? "");
        if (used >= (target?.maxTests ?? 3) || (auth && authKept >= 2)) { validDrafts.splice(validDrafts.indexOf(draft), 1); continue; }
        perRoute.set(draft.route ?? "", used + 1);
        if (auth) authKept += 1;
      }
      if (ungrounded.length) this.logger.warn(`Rejected ${ungrounded.length} ungrounded draft(s): ${ungrounded.slice(0, 5).join(" | ")}`);

      const existing = await this.prisma.testCase.findMany({ where: { projectId, status: { not: "DRAFT" } }, select: { title: true } });
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
        const createdRows = await this.prisma.testCase.createManyAndReturn({
          data: fresh.map((draft) => ({
            projectId,
            title: draft.title,
            status: "DRAFT",
            source: "ANALYSIS_GENERATED",
            capability: draft.capability,
            category: draft.category,
            priority: draft.priority,
            confidence: draft.confidence,
            route: draft.route,
            generatedFromCommit: analysis.commitSha,
            lastValidatedCommit: analysis.commitSha,
            generationRunId: runId,
            definition: { capability: draft.capability, category: draft.category, preconditions: draft.preconditions, steps: draft.steps, expectedResult: draft.expectedResult, tags: ["generated"] } as never
          })),
          select: { id: true, title: true }
        });
        const createdByTitle = new Map(createdRows.map((row) => [row.title, row.id]));
        for (const draft of fresh) {
          const createdId = createdByTitle.get(draft.title);
          if (!createdId) continue;
          await this.prisma.testCaseVersion.create({ data: { testCaseId: createdId, version: 1, title: draft.title, definition: { capability: draft.capability, category: draft.category, preconditions: draft.preconditions, steps: draft.steps, expectedResult: draft.expectedResult } as never, note: `Generated from analysis ${analysis.commitSha.slice(0, 7)}` } });
          await this.assignClassifications(createdId, draft, organizationId, "system");
        }
      }

      let modulesAssigned = 0;
      if (provider.impl) {
        try {
          modulesAssigned = await this.classifyUnassigned(provider.impl, organizationId, "system", projectId, ledger);
        } catch (classifyError) {
          this.logger.warn(`Existing-test classification skipped: ${classifyError instanceof Error ? classifyError.message : classifyError}`);
        }
      }
      await ledger.flush(this.prisma, { organizationId, projectId, generationRunId: runId });
      const consumed = providerName === "heuristic" ? 0 : (ledger.consumedTokens || estimatedTokens);
      const report = { stage: fresh.length ? "verifying" : "completed", planned: fresh.length, generated: fresh.length, verified: 0, heldOut: 0, skipped: skipped.map((reason) => ({ reason })), modulesAssigned, ...(providerFallbackDetail ? { providerFallback: providerFallbackDetail } : {}) };
      await this.prisma.generationRun.update({
        where: { id: runId },
        data: {
          ...(fresh.length ? {} : { status: "COMPLETED", completedAt: new Date() }),
          estimatedTokens, consumedTokens: consumed, created: fresh.length, duplicatesSkipped: duplicates, report: report as never
        }
      });
      if (fresh.length) await enqueueVerification(runId, 1);
      await recordAudit(this.prisma, {
        organizationId, actorId: "system", action: "generation.drafted",
        targetType: "GenerationRun", targetId: runId, metadata: { created: fresh.length, duplicates, ungrounded: ungrounded.length, skipped: skipped.length, provider: providerName, ...(providerFallbackDetail ? { providerFallback: providerFallbackDetail } : {}) }
      });
    } catch (error) {
      await this.prisma.generationRun.update({ where: { id: runId }, data: { status: "FAILED", completedAt: new Date(), errorMessage: error instanceof Error ? error.message : "Generation failed" } });
    }
  }

  /**
   * Repair pass: still-DRAFT tests from round 1 verification (failed, mutation-survived, or
   * never grounded) get one LLM attempt using what verification actually observed - the error,
   * network response, and ARIA snapshot at the moment of failure - then round 2 verification
   * judges the result. Runs in the API (grounding/billing/provider config live here).
   */
  async runRepair(runId: string): Promise<void> {
    const run = await this.prisma.generationRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== "RUNNING") return; // a redelivered job for a run that already ended
    const { projectId, organizationId } = run;
    try {
      const analysis = await this.latestAnalysis(organizationId, projectId);
      const toRepair = await this.prisma.testCase.findMany({ where: { projectId, generationRunId: runId, status: "DRAFT" }, select: { id: true, title: true, route: true, definition: true, verification: true, scenarioKey: true } });
      if (!toRepair.length || !analysis?.knowledgeModel) { await enqueueVerification(runId, 2); return; }

      const knowledgeModel = analysis.knowledgeModel as unknown as KnowledgeModel;
      const { targets } = await this.environmentTargets(projectId, knowledgeModel);

      // The scenario's own anchored action, so repair is held to the same facts the draft was written from.
      const actionFor = (scenarioKey: string | null) => {
        if (!scenarioKey) return undefined;
        const [moduleKey, actionId] = scenarioKey.split(":");
        return knowledgeModel.flowSpecs?.find((entry) => entry.moduleKey === moduleKey)?.spec.actions.find((action) => action.id === actionId);
      };

      const provider = await this.resolveProvider();
      if (!provider.impl) { await enqueueVerification(runId, 2); return; } // nothing to repair with; round 2 holds them out with their round-1 reason

      const ledger = new UsageLedger();
      const systemPrompt = [
        "You repair ONE test's step sequence that failed dry-run verification on the real, live app, or whose assertion passed even with its key action removed (a false positive).",
        "Return ONLY JSON: {\"repairs\":[{\"id\",\"steps\":[{\"action\",\"target\",\"value?\",\"condition?\"}]}]}.",
        "'ariaAtFailure' (when present) is the real accessibility tree at the moment of failure: role/name pairs. Pick an exact target from it - never invent an element that is not there.",
        "'network' lists failed (4xx/5xx) API calls the test triggered; a validation or permission error there usually explains why a click/fill target or an assert text was wrong.",
        "When 'mutation' status is 'survived', the test's assertion proved nothing: rewrite it to check a text or response that the action actually caused, using the page data already given. If nothing can be fixed, return the steps unchanged.",
        "'action' (when present) is the scenario's anchored facts: trigger, form, rules, effects. A rewritten assert must still prove THIS action's effect - a message or value from 'action' - never a heading, nav item, toast or label that just happens to be in 'ariaAtFailure'. If no such assert is possible, return the steps unchanged.",
        "Provide an entry for EVERY test id given. Steps you are not changing should be returned unchanged. Never add steps beyond what the original test needs."
      ].join("\n");

      for (let index = 0; index < toRepair.length; index += 3) {
        const batch = toRepair.slice(index, index + 3);
        try {
          const response = await ledger.run<{ repairs?: Array<{ id?: string; steps?: CandidateDraft["steps"] }> }>(provider.impl, {
            organizationId: "", projectId: "", jobId: "repair", capability: "test-generation",
            systemPrompt,
            prompt: JSON.stringify({ tests: batch.map((test) => { const action = actionFor(test.scenarioKey); return { id: test.id, definition: test.definition, verification: test.verification, ...(action ? { action: { name: action.name, trigger: action.trigger, form: action.form, backendRules: action.backendRules, effects: action.effects } } : {}) }; }) }),
            schemaName: "RepairList", schema: {}, temperature: 0
          });
          for (const entry of response.output?.repairs ?? []) {
            if (!entry?.id) continue;
            const test = batch.find((item) => item.id === entry.id);
            if (!test) continue;
            const stored = test.definition as unknown as { capability: string; category: CandidateDraft["category"]; preconditions: string[]; steps: CandidateDraft["steps"]; expectedResult: string; tags?: string[] } | null;
            if (!stored) continue;
            const draft: CandidateDraft = { title: test.title, capability: stored.capability, category: stored.category, priority: "MEDIUM", route: test.route ?? undefined, confidence: 0.5, preconditions: stored.preconditions, steps: entry.steps ?? stored.steps, expectedResult: stored.expectedResult, tags: stored.tags };
            let clean: CandidateDraft | null = null;
            try { clean = this.sanitizeDraft(draft); } catch { /* malformed model output */ }
            if (!clean) continue;
            const action = actionFor(test.scenarioKey);
            const variantId = test.scenarioKey?.split(":")[3];
            if (action) clean = { ...clean, steps: alignToAction(clean.steps, action, variantId) };
            if (action && !touchesTrigger(clean.steps, action)) continue; // repair swapped the action for something else (e.g. a nav link)
            const evidence = action ? buildSpecEvidence(action) : undefined;
            const lastAssert = clean.steps.filter((step) => step.action === "assert" && step.condition !== "urlMatches").at(-1);
            const typed = new Set(clean.steps.flatMap((step) => step.value ? [this.norm(step.value)] : []));
            if (evidence && lastAssert && !this.found(evidence, lastAssert.target) && !typed.has(this.norm(lastAssert.target))) continue; // repair swapped the outcome for page chrome
            const outcome = this.groundDraft(clean, targets, knowledgeModel, evidence);
            if (typeof outcome === "string") continue; // still ungrounded; round 2 verification holds it out with its round-1 reason
            const definition = { capability: outcome.capability, category: outcome.category, preconditions: outcome.preconditions, steps: outcome.steps, expectedResult: outcome.expectedResult, tags: stored.tags ?? ["generated"] };
            await this.prisma.testCase.update({ where: { id: test.id }, data: { definition: definition as never } });
            await this.prisma.testCaseVersion.upsert({
              where: { testCaseId_version: { testCaseId: test.id, version: 3 } },
              create: { testCaseId: test.id, version: 3, title: test.title, definition: definition as never, note: "Repaired after dry-run verification" },
              update: { definition: definition as never }
            });
          }
        } catch (batchError) {
          this.logger.warn(`Repair batch failed: ${batchError instanceof Error ? batchError.message : batchError}`);
        }
      }
      await ledger.flush(this.prisma, { organizationId, projectId, generationRunId: runId });
      await enqueueVerification(runId, 2);
    } catch (error) {
      this.logger.warn(`Repair failed for run ${runId}: ${error instanceof Error ? error.message : error}`);
      await enqueueVerification(runId, 2).catch(() => undefined); // still let round 2 hold the survivors out, with their round-1 reason
    }
  }

  /** Validates, queues the spec-grounded generation path, and returns immediately - same contract as generateCandidates. `modules` restricts planning to those moduleKeys (a live check on one module instead of a multi-hour whole-app run). */
  async generateSpecCandidates(user: AuthenticatedUser, projectId: string, options: { modules?: string[] } = {}) {
    await this.permissions.assert(user, PERMISSIONS.TEST_CASES_CREATE);
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    const context = await subscriptionContext(this.prisma, user.organizationId);
    assertBillingActive(context, "Test generation");
    const active = await this.activeRun(projectId);
    if (active) return { generationId: active.id };
    const analysis = await this.latestAnalysis(user.organizationId, projectId);
    const knowledgeModel = analysis?.knowledgeModel as unknown as KnowledgeModel | undefined;
    if (!knowledgeModel?.flowSpecs?.length) throw new BadRequestException("Analyze the repository before spec-grounded generation — no flow specs are available yet");
    assertQuota(context, 20_000, "Test generation");

    const run = await this.prisma.generationRun.create({
      data: { organizationId: user.organizationId, projectId, baseCommit: analysis!.commitSha, targetCommit: analysis!.commitSha, mode: "INCREMENTAL", status: "QUEUED", report: { stage: "queued", modulesFilter: options.modules ?? null } as never }
    });
    await enqueueSpecGeneration(run.id);
    return { generationId: run.id };
  }

  /** Plans scenarios from the latest flow specs (deterministic, no LLM) and drafts wave A (the setup-chain happy paths), or everything when no chain exists. */
  async runSpecGeneration(runId: string): Promise<void> {
    const run = await this.prisma.generationRun.findUnique({ where: { id: runId }, include: { project: true } });
    if (!run || run.status !== "QUEUED") return;
    await this.prisma.generationRun.update({ where: { id: runId }, data: { status: "RUNNING" } });
    const { projectId, organizationId } = run;
    try {
      const { moduleSpecs, knowledgeModel } = await this.loadModuleSpecs(organizationId, projectId, run.report);
      if (!moduleSpecs.length) { await this.prisma.generationRun.update({ where: { id: runId }, data: { status: "COMPLETED", completedAt: new Date(), report: { stage: "completed", planned: 0, generated: 0 } as never } }); return; }

      const existingKeys = await this.existingScenarioKeys(projectId);
      const { scenarios, skipped } = planScenarios(moduleSpecs, { existingScenarioKeys: existingKeys, knownPermissions: null });
      const chainActionKeys = new Set(scenarios.flatMap((scenario) => (scenario.setup.chain ?? []).map((action) => `${scenario.moduleKey}:${action.id}`)));
      const waveA = scenarios.filter((scenario) => scenario.category === "HAPPY_PATH" && chainActionKeys.has(`${scenario.moduleKey}:${scenario.actionId}`));
      const wave: "A" | "B" = waveA.length ? "A" : "B";
      const toGenerate = waveA.length ? waveA : scenarios;

      const provider = await this.resolveProvider();
      if (!provider.impl) throw new BadRequestException("Spec-grounded generation needs an AI provider");
      const { targets } = await this.environmentTargets(projectId, knowledgeModel);
      const ledger = new UsageLedger();

      const rejected: Array<{ scenarioKey: string; reason: string }> = [];
      const drafted = await this.draftAndSaveScenarios(toGenerate, targets, knowledgeModel, provider.impl, runId, projectId, organizationId, ledger, rejected);
      await ledger.flush(this.prisma, { organizationId, projectId, generationRunId: runId });

      // Nothing in wave A needed drafting (all already existing): go straight to wave B, keeping the run alive for it.
      const straightToWaveB = !drafted.length && wave === "A";
      const continues = drafted.length > 0 || straightToWaveB;
      const report = { stage: drafted.length ? "verifying" : straightToWaveB ? "generating-wave-b" : "completed", wave, planned: toGenerate.length, generated: drafted.length, verified: 0, heldOut: 0, skipped: [...skipped.map((entry) => ({ scenarioKey: entry.scenarioKey, reason: entry.reason })), ...rejected] };
      await this.prisma.generationRun.update({ where: { id: runId }, data: { status: continues ? "RUNNING" : "COMPLETED", completedAt: continues ? null : new Date(), created: drafted.length, report: report as never } });
      if (drafted.length) await enqueueVerification(runId, 1);
      else if (straightToWaveB) await enqueueSpecWaveB(runId);
    } catch (error) {
      await this.prisma.generationRun.update({ where: { id: runId }, data: { status: "FAILED", completedAt: new Date(), errorMessage: error instanceof Error ? error.message : "Spec generation failed" } });
    }
  }

  /**
   * Wave B: re-plans (cheap, deterministic - wave A's own scenarioKeys are now in the dedupe set
   * either way) and drafts everything left. A chain scenario whose setup actions all reached
   * PENDING_REVIEW gets their verified steps as its recipe; a chain that never verified falls back
   * to the "existing" strategy rather than being skipped, per the plan's fallback rule.
   */
  async runSpecWaveB(runId: string): Promise<void> {
    const run = await this.prisma.generationRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== "RUNNING") return; // a redelivered job for a run that already ended
    const { projectId, organizationId } = run;
    try {
      const { moduleSpecs, knowledgeModel } = await this.loadModuleSpecs(organizationId, projectId, run.report);
      const existingKeys = await this.existingScenarioKeys(projectId);
      const { scenarios, skipped } = planScenarios(moduleSpecs, { existingScenarioKeys: existingKeys, knownPermissions: null });

      const verifiedByKey = new Map((await this.prisma.testCase.findMany({ where: { projectId, status: "PENDING_REVIEW", scenarioKey: { not: null } }, select: { scenarioKey: true, definition: true } })).map((row) => [row.scenarioKey!, row.definition as unknown as { steps?: CandidateDraft["steps"] } | null]));
      const withRecipes: Array<PlannedScenario & { recipeSteps?: CandidateDraft["steps"] }> = scenarios.map((scenario) => {
        if (scenario.setup.strategy !== "chain" || !scenario.setup.chain) return scenario;
        const recipeSteps: CandidateDraft["steps"] = [];
        for (const action of scenario.setup.chain) {
          const steps = verifiedByKey.get(`${scenario.moduleKey}:${action.id}:HAPPY_PATH`)?.steps;
          if (!steps) return { ...scenario, setup: { strategy: "existing" as const } }; // a chain link never verified - fall back rather than skip
          recipeSteps.push(...steps.filter((step) => step.action !== "navigate").map((step) => ({ ...step, key: undefined })));
        }
        return { ...scenario, recipeSteps };
      });

      const provider = await this.resolveProvider();
      if (!provider.impl) throw new BadRequestException("Spec-grounded generation needs an AI provider");
      const { targets } = await this.environmentTargets(projectId, knowledgeModel);
      const ledger = new UsageLedger();

      const rejected: Array<{ scenarioKey: string; reason: string }> = [];
      const drafted = await this.draftAndSaveScenarios(withRecipes, targets, knowledgeModel, provider.impl, runId, projectId, organizationId, ledger, rejected);
      await ledger.flush(this.prisma, { organizationId, projectId, generationRunId: runId });

      const previous = (run.report as { verified?: number; heldOut?: number; planned?: number } | null) ?? {};
      const report = { stage: drafted.length ? "verifying" : "completed", wave: "B", planned: (previous.planned ?? 0) + withRecipes.length, generated: drafted.length, verified: previous.verified ?? 0, heldOut: previous.heldOut ?? 0, skipped: [...skipped.map((entry) => ({ scenarioKey: entry.scenarioKey, reason: entry.reason })), ...rejected] };
      await this.prisma.generationRun.update({ where: { id: runId }, data: { status: drafted.length ? "RUNNING" : "COMPLETED", completedAt: drafted.length ? null : new Date(), created: { increment: drafted.length }, report: report as never } });
      if (drafted.length) await enqueueVerification(runId, 1);
    } catch (error) {
      await this.prisma.generationRun.update({ where: { id: runId }, data: { status: "FAILED", completedAt: new Date(), errorMessage: error instanceof Error ? error.message : "Spec wave B failed" } });
    }
  }

  private async loadModuleSpecs(organizationId: string, projectId: string, report: unknown): Promise<{ moduleSpecs: ModuleSpec[]; knowledgeModel: KnowledgeModel }> {
    const analysis = await this.latestAnalysis(organizationId, projectId);
    const knowledgeModel = (analysis?.knowledgeModel as unknown as KnowledgeModel | undefined) ?? {};
    const modulesFilter = (report as { modulesFilter?: string[] | null } | null)?.modulesFilter ?? null;
    const moduleSpecs: ModuleSpec[] = (knowledgeModel.flowSpecs ?? [])
      .filter((entry) => !modulesFilter || modulesFilter.includes(entry.moduleKey))
      .map((entry) => ({ moduleKey: entry.moduleKey, spec: entry.spec }));
    return { moduleSpecs, knowledgeModel };
  }

  private async existingScenarioKeys(projectId: string): Promise<Set<string>> {
    const rows = await this.prisma.testCase.findMany({ where: { projectId, scenarioKey: { not: null }, status: { not: "ARCHIVED" } }, select: { scenarioKey: true } });
    return new Set(rows.map((row) => row.scenarioKey!));
  }

  /** Batches scenarios (4 per call) to the model, grounds each result against real app inventory + this action's own anchored facts, and saves whatever survives as a DRAFT TestCase with its scenarioKey. */
  private async draftAndSaveScenarios(
    scenarios: Array<PlannedScenario & { recipeSteps?: CandidateDraft["steps"] }>,
    targets: Target[], knowledgeModel: KnowledgeModel, impl: ModelProvider, runId: string, projectId: string, organizationId: string, ledger: UsageLedger,
    rejected: Array<{ scenarioKey: string; reason: string }> = []
  ): Promise<CandidateDraft[]> {
    if (!scenarios.length) return [];
    const moduleNames = new Map((knowledgeModel.flowSpecs ?? []).map((entry) => [entry.moduleKey, entry.name]));
    const saved: CandidateDraft[] = [];

    for (let index = 0; index < scenarios.length; index += 4) {
      const batch = scenarios.slice(index, index + 4);
      const payload = batch.map((scenario) => {
        const page = knowledgeModel.discoveredPages?.find((entry) => entry.route === scenario.action.trigger.route);
        return scenarioPromptPayload({
          scenario,
          routeInventory: page && !page.authGated ? { buttons: page.buttons, inputs: page.inputs, headings: page.headings, navItems: page.navItems } : undefined,
          aria: page?.aria,
          recipeSteps: scenario.recipeSteps
        });
      });
      let drafts: SpecDraft[] = [];
      try {
        const response = await ledger.run<{ drafts?: SpecDraft[] }>(impl, {
          organizationId: "", projectId: "", jobId: `spec-generation-${runId}`, capability: "test-generation",
          systemPrompt: SPEC_GENERATOR_SYSTEM_PROMPT, prompt: JSON.stringify({ today: new Date().toISOString().slice(0, 10), scenarios: payload }), schemaName: "SpecDraftList", schema: {}, temperature: 0
        });
        drafts = response.output?.drafts ?? [];
      } catch (error) {
        this.logger.warn(`Spec draft batch failed: ${error instanceof Error ? error.message : error}`);
        for (const scenario of batch) rejected.push({ scenarioKey: scenario.scenarioKey, reason: `draft batch failed: ${error instanceof Error ? error.message : error}`.slice(0, 300) });
        continue;
      }

      const returned = new Set(drafts.map((raw) => raw.scenarioKey));
      for (const scenario of batch) if (!returned.has(scenario.scenarioKey)) rejected.push({ scenarioKey: scenario.scenarioKey, reason: "model returned no draft" });
      for (const raw of drafts) {
        const scenario = batch.find((entry) => entry.scenarioKey === raw.scenarioKey);
        if (!scenario) continue;
        if (/insufficient grounding/i.test(raw.expectedResult ?? "")) { rejected.push({ scenarioKey: scenario.scenarioKey, reason: "model reported insufficient grounding" }); continue; }
        const candidate: CandidateDraft = {
          title: raw.title, capability: raw.capability || scenario.action.name, category: this.normalizeCategory(raw.category || scenario.category),
          priority: "MEDIUM", route: scenario.action.trigger.route, module: moduleNames.get(scenario.moduleKey),
          confidence: raw.confidence ?? 0.6, preconditions: raw.preconditions ?? [], steps: raw.steps ?? [], expectedResult: raw.expectedResult || scenario.description
        };
        let clean: CandidateDraft | null = null;
        try { clean = this.sanitizeDraft(candidate); } catch { /* malformed model output */ }
        if (!clean) { rejected.push({ scenarioKey: scenario.scenarioKey, reason: "malformed draft (no title or no valid steps)" }); continue; }
        clean = { ...clean, steps: alignToAction(clean.steps, scenario.action, scenario.variantId) };
        if (!touchesTrigger(clean.steps, scenario.action)) { rejected.push({ scenarioKey: scenario.scenarioKey, reason: `never touches the action's trigger "${scenario.action.trigger.label}"` }); continue; }
        const outcome = this.groundDraft(clean, targets, knowledgeModel, buildSpecEvidence(scenario.action));
        if (typeof outcome === "string") { rejected.push({ scenarioKey: scenario.scenarioKey, reason: `rejected by grounding: ${outcome}` }); continue; }

        const created = await this.prisma.testCase.create({
          data: {
            projectId,
            title: outcome.title, status: "DRAFT", source: "ANALYSIS_GENERATED", capability: outcome.capability, category: outcome.category,
            priority: outcome.priority, confidence: outcome.confidence, route: outcome.route, generationRunId: runId, scenarioKey: scenario.scenarioKey,
            definition: { capability: outcome.capability, category: outcome.category, preconditions: outcome.preconditions, steps: outcome.steps, expectedResult: outcome.expectedResult, tags: ["generated", "spec-grounded"] } as never
          }
        }).catch((error: { code?: string }) => {
          // P2002: the scenario was drafted meanwhile (scenarioKey is unique per project) - skip it, never fail the run.
          if (error?.code === "P2002") { rejected.push({ scenarioKey: scenario.scenarioKey, reason: "already drafted" }); return null; }
          throw error;
        });
        if (!created) continue;
        await this.prisma.testCaseVersion.create({ data: { testCaseId: created.id, version: 1, title: outcome.title, definition: { capability: outcome.capability, category: outcome.category, preconditions: outcome.preconditions, steps: outcome.steps, expectedResult: outcome.expectedResult } as never, note: `Spec-grounded draft for ${scenario.scenarioKey}` } });
        // The module comes from the spec itself (no classifier call needed): the test belongs to the module its action was found in.
        await this.assignClassifications(created.id, { ...outcome, module: moduleNames.get(scenario.moduleKey) }, organizationId, "system");
        saved.push(outcome);
      }
    }
    return saved;
  }

  /** LLM output is untrusted: coerce categories, priorities, steps and confidence into valid shapes. */
  private sanitizeDraft(raw: CandidateDraft): CandidateDraft | null {
    const title = String(raw?.title ?? "").trim();
    if (!title) return null;
    const knownActions = ["navigate", "click", "fill", "select", "upload", "assert", "waitfor", "assertresponse"];
    const steps = (Array.isArray(raw.steps) ? raw.steps : [])
      .map((step) => ({
        action: String(step?.action ?? "").toLowerCase().trim(),
        target: this.normalizeStepTarget(String(step?.target ?? "").trim()),
        ...(step?.value !== undefined && step?.value !== null && String(step.value) !== "" ? { value: String(step.value) } : {}),
        ...(step?.condition !== undefined && step?.condition !== null && String(step.condition) !== "" ? { condition: String(step.condition).toLowerCase().trim() } : {}),
        ...(step?.key === true ? { key: true } : {}),
        ...(typeof step?.role === "string" && step.role ? { role: step.role } : {}),
        ...(typeof step?.within === "string" && step.within.trim() ? { within: step.within.trim() } : {})
      }))
      .filter((step) => knownActions.includes(step.action) && step.target)
      .map((step) => ({ ...step, action: step.action === "waitfor" ? "waitFor" : step.action === "assertresponse" ? "assertResponse" : step.action }));
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
   * Plain-English flow -> AI-drafted TestDefinition, grounded in the
   * latest analysis knowledge model (routes + discovered real controls).
   * Draft only — the caller reviews it in the editor before saving.
   */
  async aiDraft(user: AuthenticatedUser, projectId: string, description: string) {
    if (!description?.trim()) throw new BadRequestException("description is required");
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    const analysis = await this.latestAnalysis(user.organizationId, projectId);
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
    const pages = [...(model.discoveredPages ?? [])].filter((page) => !page.authGated).sort((a, b) => scorePage(b) - scorePage(a)).slice(0, 3);

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
      schema: {},
      temperature: 0
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

  /** The model sometimes writes instructions into targets ("click on Save button"): reduce them to the bare element name; URLs pass through as-is. */
  private normalizeStepTarget(target: string): string {
    if (!target || /^[/?#]/.test(target) || /^https?:\/\//i.test(target)) return target;
    let cleaned = target;
    const prefix = cleaned.match(/^(?:cl+ick|tap|press|select|choose|go to|navigate to|open)\s+(?:on\s+|the\s+)?(.+)$/i);
    if (prefix) cleaned = prefix[1];
    // The model sometimes echoes a control's own kind back as a prefix on its target ("button: Add
    // Category" instead of "Add Category") - that kind label is never actually on the page.
    cleaned = cleaned.replace(/^(?:button|input|textarea|select|switch|checkbox|radio|link|tab|menu)\s*:\s*/i, "");
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

  /**
   * Targets = routes whose page was really opened with real controls. Every other
   * route is skipped WITH a reason the user can act on — never guessed at.
   */
  private buildTargets(model: KnowledgeModel, fixtures: Record<string, Record<string, string>>): { targets: Target[]; skipped: string[] } {
    const discovered = model.discoveredPages ?? [];
    const targets: Target[] = [];
    const skipped: string[] = [];
    for (const route of model.routes ?? []) {
      if (route.path === "*") continue;
      const fixture = fixtures[route.path];
      const needed = (route.params ?? []).map((param) => param.name);
      if (needed.length && !fixture) {
        skipped.push(`${route.path} — needs values for ${needed.join(", ")}. Add them under Settings > Environments > Parameter values (use {} if the page needs none).`);
        continue;
      }
      const page = discovered.find((entry) => entry.route === route.path);
      if (page?.authGated) {
        skipped.push(`${route.path} — the crawler only saw a login screen. ${model.loginStatus === "failed" ? "The saved login failed; fix the credentials in Settings." : model.loginStatus === "ok" ? "Login succeeded but the page still asks for login; check the login URL or trigger." : "Add login credentials to the environment in Settings."} Then analyze again.`);
        continue;
      }
      if (page?.redirectedTo) {
        skipped.push(`${route.path} — the app sends this route to ${page.redirectedTo}, so its own controls could not be read.`);
        continue;
      }
      if (page && fixture && Object.keys(fixture).length && page.paramsVerified === false) {
        skipped.push(`${route.path} — opened with the saved parameter values but the page looked the same as without them. Check the values in Settings.`);
        continue;
      }
      // route.files is the page file plus its near import neighborhood (modals, columns, hooks it imports) -
      // real repo paths now that code-context.ts stores files by their actual path, not a flattened one.
      const codeFiles = route.files ?? (route.file ? [route.file] : []);
      const code = codeFiles.length
        ? (model.codeContext ?? []).filter((entry) => codeFiles.includes(entry.file))
        : (model.codeContext ?? []).filter((entry) => entry.component === route.page);
      if (!page && !code.some((entry) => entry.renderedElements.length)) {
        skipped.push(`${route.path} — the page could not be opened in the live app and no controls were found in its code.`);
        continue;
      }
      targets.push({ capability: route.feature, route: route.path, url: this.placeholderUrl(route.path, Object.keys(fixture ?? {})), page, code, maxTests: testBudget(page, isAuthRoute(route.path)) });
    }
    return { targets, skipped };
  }

  /**
   * Targets from the project's Route Map: only VERIFIED, non-excluded routes. Values the crawl proved
   * (sample ids / query values) become fixtures when the user has not set their own. Returns null
   * when the project has no Route Map yet (older projects fall back to the analysis snapshot).
   */
  private async routeTargets(projectId: string, fixtures: Record<string, Record<string, string>>, model: KnowledgeModel) {
    const rows = await this.prisma.projectRoute.findMany({ where: { projectId, excluded: false } });
    if (!rows.length) return null;
    const targets: Target[] = [];
    const skipped: string[] = [];
    const autoFixtures: Record<string, Record<string, string>> = {};
    const ordered = [...rows].sort((a, b) =>
      Number(isAuthRoute(a.pattern)) - Number(isAuthRoute(b.pattern)) || Number(b.pinned) - Number(a.pinned) || (a.navOrder ?? 1e6) - (b.navOrder ?? 1e6) || a.pattern.localeCompare(b.pattern));
    for (const row of ordered) {
      if (row.pattern === "*") continue;
      const page = row.inventory as unknown as DiscoveredPage | null;
      if (row.status !== "VERIFIED" || !page) {
        if (row.pinned || row.sources.includes("user")) skipped.push(`${row.pattern} — ${row.reason ?? "not opened in the live app yet"}.`);
        continue;
      }
      const params = (row.params as Array<{ name: string; in: string; samples: string[] }> | null) ?? [];
      const userFixture = fixtures[row.pattern];
      // Query params are optional filters: a crawl sample (e.g. search=foo) would narrow the page, so only path params are auto-filled.
      const auto = Object.fromEntries(params.filter((param) => param.in === "path" && param.samples?.length).map((param) => [param.name, param.samples[0]]));
      const fixture = userFixture ?? (Object.keys(auto).length ? auto : undefined);
      if (!userFixture && fixture) autoFixtures[row.pattern] = fixture;
      const routeFiles = (model.routes ?? []).find((entry) => entry.path === row.pattern)?.files ?? (row.pageFile ? [row.pageFile] : []);
      const code = routeFiles.length ? (model.codeContext ?? []).filter((entry) => routeFiles.includes(entry.file)) : [];
      targets.push({
        capability: row.label ?? row.pattern, route: row.pattern, url: this.placeholderUrl(row.pattern, Object.keys(fixture ?? {})),
        page: page as DiscoveredPage, code, maxTests: testBudget(page, isAuthRoute(row.pattern)), label: row.label ?? undefined, apiCalls: row.apiCalls
      });
    }
    return { targets, skipped, autoFixtures };
  }

  /** `/shop/:id` + keys [id, color] -> `/shop/{{id}}?color={{color}}` — the runner fills {{name}} from environment fixtures. */
  private placeholderUrl(route: string, keys: string[]): string {
    const path = route.replace(/:([A-Za-z_]\w*)/g, (whole, name: string) => (keys.includes(name) ? `{{${name}}}` : whole));
    const query = keys.filter((key) => !new RegExp(`:${key}\\b`).test(route)).map((key) => `${encodeURIComponent(key)}={{${key}}}`).join("&");
    return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
  }

  private norm(value: string): string {
    return value.toLowerCase().replace(/\s+/g, " ").replace(/[.:…]+$/, "").trim();
  }

  /** Strings the live page really shows (live) and literal labels from the app's code (code). */
  private inventory(target: Target, model: KnowledgeModel) {
    const live = new Set<string>();
    const code = new Set<string>();
    const page = target.page && !target.page.authGated ? target.page : undefined;
    if (page) {
      const values = [...page.buttons, ...page.navItems, ...page.inputs, ...page.headings, ...(page.clickables ?? []),
        ...(page.selects ?? []).flatMap((select) => [select.name, ...select.options]), ...(page.labelPairs ?? []).flatMap((pair) => [pair.input, pair.label])];
      for (const value of values) if (value) live.add(this.norm(value));
    }
    // Labels from this page's own code (and its near neighborhood: modals, columns, hooks) only -
    // the whole app's labels are too permissive a fallback for the grounding gate.
    for (const entry of target.code) for (const element of entry.renderedElements) if (element.label && !/[{}$]/.test(element.label)) code.add(this.norm(element.label));
    return { live, code, text: this.norm(page?.pageText ?? "") };
  }

  /** The target text is on the page (exact, or contained in a longer real label — the runner matches partially too). */
  private found(set: Set<string>, value: string): boolean {
    const wanted = this.norm(value);
    if (!wanted) return false;
    if (set.has(wanted)) return true;
    return wanted.length >= 3 && [...set].some((label) => label.includes(wanted));
  }

  /**
   * Grounding gate: every step must point at something the system saw. Returns the
   * draft (route, opening navigate and confidence set by the system) or the reason it was rejected.
   */
  private groundDraft(draft: CandidateDraft, targets: Target[], model: KnowledgeModel, specEvidence?: Set<string>): CandidateDraft | string {
    const target = targets.find((entry) => entry.route === draft.route) ?? targets.find((entry) => entry.capability === draft.capability);
    if (!target) return "the page is not one the app really has";
    const { live, code, text } = this.inventory(target, model);
    const knownRoutes = [...(model.routes ?? []).map((route) => route.path), ...targets.map((entry) => entry.route)].map((path) => new RegExp("^" + path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]\w*/g, "[^/?#]+") + "/?$"));
    let interacted = false;
    // Values this draft typed: a record it created shows up in the list under that text, so asserting it later (visible, or hidden once deleted) is about text the page really showed.
    const typedValues = new Set<string>();
    let allLive = true;
    // Set whenever an interactive step's target names a control the crawler actually exercised: the
    // very next assert/waitFor is then held to what that control really changed, not a static guess.
    let lastControlBehavior: ControlBehavior | undefined;
    let lastApplied: string | undefined;
    let lastClickWasNav = false;
    // A hidden-only check also passes when the page just broke: after a filter, something must be shown too.
    let pendingGone: { behavior: ControlBehavior; at: number } | undefined;
    let sawProof = false;
    // A bare control label ("Clear" appearing once you type) is not a result; at least one assert must be about the data.
    let dataProof = false;
    const chrome = new Set((target.page?.buttons ?? []).filter((label) => label.length <= 24 && !/\d/.test(label)).map((label) => this.norm(label)));
    const body: CandidateDraft["steps"] = [];
    const settleGone = (): string | null => {
      if (!pendingGone || sawProof) { pendingGone = undefined; return null; }
      const proof = [...(pendingGone.behavior.kept ?? []), ...pendingGone.behavior.appeared][0];
      if (!proof) return `only checks that things disappeared after ${pendingGone.behavior.control.label} = "${pendingGone.behavior.valueTried}"; nothing was observed to show the page still works`;
      body.splice(pendingGone.at, 0, { action: "assert", target: proof, condition: "visible" });
      pendingGone = undefined;
      return null;
    };
    for (const step of draft.steps) {
      if (step.action === "navigate") {
        const path = step.target.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0];
        if (body.length === 0) continue; // the opening navigate is written by the system
        if (!path.startsWith("/") || !knownRoutes.some((pattern) => pattern.test(path))) return `navigates to "${step.target}", which is not a route of the app`;
        body.push(step);
        continue;
      }
      if (step.action === "assert" && step.condition === "urlMatches") { body.push(step); continue; }
      if (step.action === "assertResponse") {
        // An unsupported assertResponse is dropped, not fatal: the rest of the test is judged on its own,
        // and the "must still assert something" check below rejects it if nothing else is left.
        if (this.groundResponseStep(step, target)) continue;
        if (lastControlBehavior) {
          // The list must be one the control just used actually fetched, not another call the page made on load.
          const calls = [lastControlBehavior.responseCall, ...lastControlBehavior.requestsFired.map((call) => call.replace(/^GET\s+/, ""))].filter((call): call is string => Boolean(call));
          if (!calls.some((call) => matchesApiCall(step.target, "GET", call))) continue;
        }
        sawProof = true;
        dataProof = true;
        body.push(step);
        continue;
      }
      if (/^\{\{\s*(username|password)\s*\}\}$/i.test(step.target)) { body.push(step); continue; }
      const interactive = ["click", "fill", "select", "upload"].includes(step.action);
      if (interactive) {
        const inLive = this.found(live, step.target);
        if (!inLive && !this.found(code, step.target) && !(specEvidence && this.found(specEvidence, step.target))) return `${step.action} "${step.target}" is not a control the app shows`;
        if (!inLive) allLive = false;
        interacted = true;
        if (step.value) typedValues.add(this.norm(step.value));
        const settled = settleGone();
        if (settled) return settled;
        sawProof = false;
        lastClickWasNav = step.action === "click" && this.found(new Set((target.page?.navItems ?? []).map((item) => this.norm(item))), step.target);
        // Matched by label only (not value: the draft's typed value differs from the crawler's probe
        // text) - a select/fill naming a control the crawler exercised holds the next assert to what
        // that control really changed; clicking something else (or an unexercised control) clears it.
        // Two exercised controls set in a row: hold the next assert to what that PAIR really did (the
        // crawler's combo entry), not the second control's solo behavior.
        // ponytail: no combo observed for this pair (time cap) falls back to the solo entry, a looser check.
        const page = target.page && !target.page.authGated ? target.page : undefined;
        const label = this.norm(step.target);
        const behaviors = page?.controlBehaviors ?? [];
        // The same control can be observed with different values (one that matched, one that matched nothing):
        // prefer the entry for the value this step types or selects.
        const sameControl = behaviors.filter((behavior) => this.norm(behavior.control.label) === label);
        const byValue = (list: ControlBehavior[]) => list.find((behavior) => step.value !== undefined && this.norm(behavior.valueTried) === this.norm(step.value)) ?? list[0];
        const combo = lastApplied ? byValue(sameControl.filter((behavior) => behavior.after && this.norm(behavior.after.control.label) === lastApplied)) : undefined;
        lastControlBehavior = combo ?? byValue(sameControl.filter((behavior) => !behavior.after));
        lastApplied = lastControlBehavior ? label : undefined;
      } else {
        // assert / waitFor: initial text must be on the page; text after an action may be an outcome message.
        const normTarget = this.norm(step.target);
        const hidden = step.condition === "hidden";
        const behavior = lastControlBehavior;
        const inBehavior = (list?: string[]) => (list ?? []).some((value) => this.norm(value) === normTarget);
        const fromBehavior = Boolean(behavior) && (inBehavior(behavior!.appeared) || inBehavior(behavior!.disappeared) || inBehavior(behavior!.kept));
        if (isNoiseText(step.target)) return `${step.action} "${step.target}" is a count or run-together label that changes with the data - assert a stable text instead`;
        // A long assert target is normally the model inventing prose, UNLESS it's a message already
        // anchored on the spec action itself (a real backend-rule or effect message) - that one is
        // exactly the outcome a NEGATIVE/rule scenario is supposed to prove, however many words long.
        if (!fromBehavior && step.target.trim().split(/\s+/).length >= 9 && !(specEvidence && this.found(specEvidence, step.target))) return `${step.action} "${step.target}" is a descriptive sentence, not an outcome of the action`;
        const inSpec = Boolean(specEvidence && this.found(specEvidence, step.target));
        const onPageAlready = this.found(live, step.target) || (text !== "" && text.includes(normTarget));
        // A rule/effect message only appears after the action runs: asserting it before any interaction proves nothing.
        if (inSpec && !interacted && !onPageAlready && !hidden) return `${step.action} "${step.target}" is an outcome message but the test never performs the action`;
        const inPage = onPageAlready || this.found(code, step.target) || inSpec || typedValues.has(normTarget);
        if (!chrome.has(normTarget)) dataProof = true;
        if (behavior && fromBehavior) {
          // Held to what this exact control really did: gone texts can only be hidden, new or kept texts only visible.
          if (inBehavior(behavior.disappeared)) {
            if (!hidden) return `${step.action} "${step.target}" disappeared when the crawler tried ${behavior.control.label} = "${behavior.valueTried}", so it cannot be visible afterwards`;
            pendingGone = { behavior, at: body.length + 1 };
          } else {
            if (hidden) return `${step.action} "${step.target}" was still showing after ${behavior.control.label} = "${behavior.valueTried}", so it cannot be hidden`;
            sawProof = true;
          }
        } else if (!inPage) {
          // A hidden check on text never seen anywhere (not live, not code, not any observed behavior)
          // has nothing to go false when the bug it's meant to catch happens - it always passes.
          if (hidden) return `${step.action} "${step.target}" is not text ever seen on this page - asserting it is hidden proves nothing`;
          if (!interacted) return `${step.action} "${step.target}" is not text the page shows`;
          allLive = false;
        } else if (behavior) {
          return `${step.action} "${step.target}" was unchanged when the crawler tried ${behavior.control.label} = "${behavior.valueTried}" - it proves nothing about that action`;
        } else if (interacted && !hidden && !lastClickWasNav && (this.found(live, step.target) || (text !== "" && text.includes(normTarget)))) {
          // No observed behavior: text that was already there before the action cannot prove the action did anything.
          return `${step.action} "${step.target}" was already on the page before the action - it proves nothing about it`;
        }
      }
      body.push(step);
    }
    const unsettled = settleGone();
    if (unsettled) return unsettled;
    const asserted = body.some((step) => step.action === "assert" || step.action === "assertResponse" || step.action === "waitFor");
    if (!asserted) return "nothing left to assert once the unsupported steps were removed";
    if (interacted && !dataProof) return "only checks a control label (e.g. a Clear button), not what the action did to the data";
    if (!body.some((step) => step.action !== "navigate")) return "no step beyond opening the page";
    if (specEvidence && !interacted) return "never performs the scenario's action - only checks the page as loaded";
    return {
      ...draft,
      route: target.route,
      steps: [{ action: "navigate", target: target.url }, ...body],
      confidence: allLive ? 0.9 : 0.7
    };
  }

  /** An assertResponse must name a list call this page was seen making, with a rule over fields (and enum values) that call really returned. */
  private groundResponseStep(step: CandidateDraft["steps"][number], target: Target): string | null {
    const page = target.page && !target.page.authGated ? target.page : undefined;
    // A control the crawler actually exercised gives the FILTERED shape (what a real value really
    // returned); check those before falling back to the unfiltered shape from the page's first load.
    const observed = (page?.controlBehaviors ?? []).flatMap((behavior) => behavior.responseShape ? (behavior.responseCall ? [behavior.responseCall] : behavior.requestsFired).map((call) => [call, behavior.responseShape!] as const) : []);
    const entry = [...observed, ...Object.entries(page?.apiShapes ?? {})].find(([call]) => matchesApiCall(step.target, "GET", call.replace(/^GET\s+/, "")));
    if (!entry) return `assertResponse "${step.target}" is not a list call this page was seen making`;
    const [call, shape] = entry;
    const rule = parseResponseRule(step.value ?? "");
    if (!rule) return `assertResponse rule "${step.value ?? ""}" is not valid (all <field> == <value> | count <op> <n> | shown <field>)`;
    if (rule.kind === "count") return null;
    const field = shape.fields.find((candidate) => candidate.name === rule.field);
    if (!field) return `assertResponse field "${rule.field}" is not returned by ${call} (fields: ${shape.fields.map((candidate) => candidate.name).join(", ")})`;
    if (rule.kind === "shown") return field.type === "string" ? null : `assertResponse shown needs a text field, "${rule.field}" is ${field.type}`;
    if (rule.op === "==" && field.values && !field.values.some((value) => this.norm(value) === this.norm(rule.value))) {
      return `assertResponse value "${rule.value}" was never seen for ${rule.field} (seen: ${field.values.join(", ")})`;
    }
    return null;
  }

  /** Attach an AI-suggested module/tags to a freshly created test, creating the org-level module/tag when missing. */
  private async assignClassifications(testCaseId: string, draft: CandidateDraft, organizationId: string, actorId: string) {
    if (draft.module) {
      const module = await this.findOrCreateModule(organizationId, draft.module, actorId);
      if (module) await this.prisma.testModuleMembership.createMany({ data: { moduleId: module.id, testCaseId }, skipDuplicates: true });
    }
    for (const tagName of draft.tags ?? []) {
      const tag = await this.findOrCreateTag(organizationId, tagName, actorId);
      if (tag) await this.prisma.testTagAssignment.createMany({ data: { tagId: tag.id, testCaseId }, skipDuplicates: true });
    }
  }

  /**
   * Organize existing AI-generated tests that have no module yet: batch their
   * titles to the model, get module + tags per test, and apply the memberships.
   */
  private async classifyUnassigned(impl: ModelProvider, organizationId: string, actorId: string, projectId: string, ledger: UsageLedger): Promise<number> {
    const unassigned = await this.prisma.testCase.findMany({
      where: { projectId, source: "ANALYSIS_GENERATED", modules: { none: {} } },
      select: { id: true, title: true, capability: true, category: true },
      take: 300
    });
    if (!unassigned.length) return 0;
    const existingModules = (await this.prisma.testModule.findMany({ where: { organizationId }, select: { name: true }, take: 60 })).map((module) => module.name);

    const systemPrompt = [
      "You organize a QA test suite by business module.",
      "Return ONLY a JSON object: {\"assignments\":[{\"id\",\"module\",\"tags\":[string]}]}.",
      "module: short Title Case business area grouping the test, e.g. 'Cart and Checkout', 'Authentication', 'Product Management', 'Color Selection', 'File Upload'. Use consistent, stable module names across the batch.",
      "tags: up to 3 lowercase labels from [smoke, critical, regression, forms, navigation, upload, auth, error-handling, e2e].",
      "Provide an assignment for EVERY test id in the input. Do not invent ids.",
      existingModules.length ? `Existing modules (REUSE these names whenever one fits): ${existingModules.join(", ")}.` : ""
    ].filter(Boolean).join(" ");

    let assigned = 0;
    for (let index = 0; index < unassigned.length; index += 20) {
      const batch = unassigned.slice(index, index + 20);
      try {
        const response = await ledger.run<{ assignments?: Array<{ id?: string; module?: string; tags?: string[] }> }>(impl, {
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
          const module = entry.module ? await this.findOrCreateModule(organizationId, entry.module, actorId) : null;
          if (module) await this.prisma.testModuleMembership.createMany({ data: { moduleId: module.id, testCaseId: entry.id }, skipDuplicates: true });
          for (const tagName of this.normalizeTags(entry.tags)) {
            const tag = await this.findOrCreateTag(organizationId, tagName, actorId);
            if (tag) await this.prisma.testTagAssignment.createMany({ data: { tagId: tag.id, testCaseId: entry.id }, skipDuplicates: true });
          }
          assigned += 1;
        }
      } catch (batchError) {
        this.logger.warn(`Classification batch failed: ${batchError instanceof Error ? batchError.message : batchError}`);
      }
    }
    if (assigned) {
      await recordAudit(this.prisma, { organizationId, actorId, action: "generation.classified_existing", targetType: "TestCase", metadata: { assigned } });
    }
    return assigned;
  }

  /** Comparable form of a module name: case, punctuation and plural insensitive, auth words unified. */
  moduleKey(name: string): string {
    const words = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (/^(auth|authentication|authorization|login|log in|sign in|signin|sign up|signup|register|registration)$/.test(words)) return "authentication";
    return words.split(" ").map((word) => (word.length > 3 ? word.replace(/ies$/, "y").replace(/s$/, "") : word)).join(" ");
  }

  /** Same module when keys are equal, or one is a >=4-character word prefix of the other ("Auth" ~ "Authentication"). */
  private sameModule(a: string, b: string): boolean {
    const [x, y] = [this.moduleKey(a), this.moduleKey(b)];
    if (x === y) return true;
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return short.length >= 4 && !short.includes(" ") && long.split(" ")[0].startsWith(short);
  }

  private async findOrCreateModule(organizationId: string, name: string, actorId: string) {
    const clean = this.normalizeModuleName(name);
    if (!clean) return null;
    const modules = await this.prisma.testModule.findMany({ where: { organizationId }, orderBy: { name: "asc" } });
    const match = modules.find((module) => module.name === clean) ?? modules.find((module) => this.sameModule(module.name, clean));
    if (match) return match;
    try {
      const created = await this.prisma.testModule.create({ data: { organizationId, name: clean } });
      await recordAudit(this.prisma, { organizationId, actorId, action: "classification.module_auto_created", targetType: "TestModule", targetId: created.id, metadata: { name: clean, auto: true } });
      return created;
    } catch {
      return this.prisma.testModule.findUnique({ where: { organizationId_name: { organizationId, name: clean } } });
    }
  }

  /** Idempotent: fold near-duplicate org modules ("Auth", "Authentication") into the longest-named one. */
  private async consolidateModules(organizationId: string) {
    const modules = await this.prisma.testModule.findMany({ where: { organizationId }, orderBy: { name: "asc" } });
    const merged = new Set<string>();
    for (const keep of [...modules].sort((x, y) => y.name.length - x.name.length)) {
      if (merged.has(keep.id)) continue;
      for (const dup of modules) {
        if (dup.id === keep.id || merged.has(dup.id) || !this.sameModule(keep.name, dup.name)) continue;
        const memberships = await this.prisma.testModuleMembership.findMany({ where: { moduleId: dup.id } });
        if (memberships.length) await this.prisma.testModuleMembership.createMany({ data: memberships.map((row) => ({ moduleId: keep.id, testCaseId: row.testCaseId })), skipDuplicates: true });
        await this.prisma.testModuleMembership.deleteMany({ where: { moduleId: dup.id } });
        await this.prisma.testModule.delete({ where: { id: dup.id } });
        merged.add(dup.id);
      }
    }
    return merged.size;
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

  /** Without a model: one smoke test per page, asserting a heading the crawler actually saw. */
  private smokeCandidates(targets: Target[]): CandidateDraft[] {
    const drafts: CandidateDraft[] = [];
    for (const target of targets) {
      const heading = target.page && !target.page.authGated ? target.page.headings[0] : undefined;
      if (!heading) continue;
      drafts.push({
        title: `${target.capability}: page loads`,
        capability: target.capability,
        category: "HAPPY_PATH",
        priority: "MEDIUM",
        route: target.route,
        confidence: 0.9,
        preconditions: [`The ${target.capability} page at ${target.route} is reachable`],
        steps: [{ action: "waitFor", target: heading, condition: "visible" }],
        expectedResult: `${target.capability} opens and shows "${heading}".`
      });
    }
    return drafts;
  }

  private async providerCandidates(
    impl: ModelProvider,
    providerName: string,
    providerModel: string,
    targets: Target[],
    model: KnowledgeModel,
    hasCredentials = false,
    existingModules: string[] = [],
    ledger: UsageLedger = new UsageLedger()
  ): Promise<CandidateDraft[]> {
    const example = (value: unknown) => JSON.stringify(value);
    const systemPrompt = [
      "You are a senior QA engineer writing scenario-based Playwright tests for a React web application.",
      "OUTPUT. Return ONLY a JSON object: {\"candidates\":[{\"basis\",\"title\",\"capability\",\"category\",\"priority\",\"route\",\"preconditions\":[string],\"steps\":[{\"action\",\"target\",\"value?\",\"condition?\"}],\"expectedResult\",\"module\",\"tags\":[string]}]}.",
      "basis: ONE short sentence, written first, naming the evidence the test rests on (an observedBehaviors control and what it changed, an apiResponses call, or a page element). If you cannot name evidence, do not write that test.",
      "actions: navigate|click|fill|select|upload|assert|waitFor|assertResponse. conditions: visible|hidden|equals|contains|urlMatches. categories: HAPPY_PATH|NEGATIVE|BOUNDARY|VALIDATION|PERMISSION|ERROR|STATE|INTEGRATION. priorities: CRITICAL|HIGH|MEDIUM|LOW.",
      "INPUT. Each capability carries 'page' (what the crawler SAW on the live, logged-in page: headings, buttons, clickables, inputs, labelPairs, selects, navItems, pageText), 'codeBehavior' (controls and handlers read from the app's source code), 'apiResponses' (list calls the page made, with their fields and real values) and 'observedBehaviors'.",
      "observedBehaviors is what REALLY happened when the crawler used a control on this page: valueTried (the exact value), the request that fired and apiResponse (its call, fields and values), and the exact texts that appeared, disappeared or were kept (still on the page and matching the value). An entry with 'after' was observed with that other control already set to its valueTried.",
      "STEPS. Every click, fill, select and upload target MUST be copied character for character from page.*, codeBehavior or observedBehaviors control.label. Never invent, rename or translate an element. Reuse valueTried as the typed or selected value. A control of kind \"tab\" is a filter button: click it by control.label (a count after its name is left out because counts change). The same control can appear with different valueTried: one that matched real rows (kept has text) and one that matched nothing (an empty-state message in appeared); each entry is its own case.",
      "The system adds the opening navigate to the page; do not write it. Parameters in 'parameters' are filled by the system. A test sets two controls in a row only when an observedBehaviors entry with 'after' exists for that pair; its assertions come from that entry, not from either control's own entry.",
      "ASSERTIONS. Every test must end by proving the action had an effect: an assertResponse, or an assert on a text from observedBehaviors (appeared or kept = visible, disappeared = hidden). After a search or filter, write BOTH sides: one hidden check from disappeared AND one visible check from kept (or the empty-state message in appeared). A test that only checks something vanished is rejected, because it also passes when the page breaks.",
      "A text in disappeared is never visible afterwards; a text in appeared or kept is never hidden. When an appeared text embeds the value tried (\"No matches for “te”.\"), use the exact valueTried.",
      "NEVER assert: numbers, counts or badges; a control that merely appears once you type (a \"Clear\" button) as the only check; labels glued to a count (\"Pending1\"); sentences that describe the page (headings, subtitles, help text); or text that was already on the page before the action and is not in kept. For a click or form flow the crawler did not perform, assert only text that appears in codeBehavior but not in page.* (it is shown after the action); if there is none, do not write an outcome assert, write a shorter test instead.",
      "assertResponse checks the list the app itself fetched after your previous step. target = a call path copied EITHER from apiResponses[].call or from observedBehaviors[].apiResponse.call, without the GET prefix (e.g. /api/orders); value = ONE rule: 'shown <field>' (the first items' text appears on the page), 'all <field> == <value>' (every item has the value), or 'count >= <n>' (== > >= < <=). <field> must be a name from that call's fields; an == value must be one of its listed values. Never invent a call or field.",
      "assertResponse strength, strongest first: 'shown <field>' after a free-text search or filter (proves the typed text drove the data) > 'all <field> == <value>' after setting a field to a known value via select, tab or filter > 'count' (only a quantity). Use 'count' only when no field matches what the previous step changed; never because it is the easiest rule to write.",
      "VARIETY. Per capability, write different categories. When observedBehaviors has both a value that matched (kept) and one that matched nothing (an empty-state message in appeared), write one happy-path and one negative test. Only use controls listed for THIS capability; never a control from another page.",
      "Examples (format only; copy no names or texts from them):",
      example({ basis: "observedBehaviors: Search items = ORD-100 kept 'ORD-100 Alpha', hid 'ORD-101 Beta'; apiResponses has GET /api/items", title: "Search items by ID shows only matching rows", capability: "Items", category: "HAPPY_PATH", priority: "HIGH", route: "/items", preconditions: [], steps: [{ action: "fill", target: "Search items", value: "ORD-100" }, { action: "assertResponse", target: "/api/items", value: "shown name" }, { action: "assert", target: "ORD-100 Alpha", condition: "visible" }, { action: "assert", target: "ORD-101 Beta", condition: "hidden" }], expectedResult: "Only the matching item stays in the list.", module: "Items", tags: ["regression"] }),
      example({ basis: "observedBehaviors: Search items = te appeared 'No matches for “te”.'", title: "Search items with no match shows the empty state", capability: "Items", category: "NEGATIVE", priority: "MEDIUM", route: "/items", preconditions: [], steps: [{ action: "fill", target: "Search items", value: "te" }, { action: "assert", target: "No matches for “te”.", condition: "visible" }], expectedResult: "An empty-state message replaces the list.", module: "Items", tags: ["regression"] }),
      hasCredentials
        ? "LOGIN. The environment has a saved login. Use {{username}} and {{password}} ONLY on the app's own sign-in form, to sign in as the saved account (username/email field value {{username}}, password field value {{password}}). Never use them on other forms such as creating or editing users or teams; write plain sample values there. Never invent credentials; use invalid made-up values only for a negative test."
        : "LOGIN. No login is saved for this environment: never invent valid credentials; sign-in tests may only cover invalid input and validation messages.",
      "Write 0 to maxTests tests per capability (maxTests is given per capability), each only when the data above supports EVERY step. If the data is not enough for a meaningful test, return no candidate for that capability. Never pad to reach a number. As many steps as the real flow needs - a longer setup (e.g. creating a record before acting on it) is not a reason to cut a test short.",
      existingModules.length ? `Existing modules (REUSE one of these names whenever it fits, never create a near-duplicate such as Auth vs Authentication): ${existingModules.join(", ")}.` : "",
      "Every candidate has \"module\": the business area in short Title Case (e.g. 'Cart and Checkout'), consistent across candidates, and \"tags\": up to 3 lowercase labels from [smoke, critical, regression, forms, navigation, upload, auth, error-handling, e2e].",
      "Titles describe the scenario ('Create product and verify it appears in catalog'), not the category."
    ].filter(Boolean).join("\n");

    // Batched: small groups keep outputs well-formed and limit blast radius.
    const batchSize = 3;
    const batches: Target[][] = [];
    for (let index = 0; index < targets.length; index += batchSize) batches.push(targets.slice(index, index + batchSize));

    const all: CandidateDraft[] = [];
    let failedBatches = 0;
    for (const batch of batches) {
      this.logger?.log?.(`Generation batch ${batches.indexOf(batch) + 1}/${batches.length}: drafting ${batch.length} target(s)`);
      const prompt = JSON.stringify({
        application: { framework: model.framework },
        capabilities: batch.map((target) => ({
          capability: target.capability,
          route: target.route,
          label: target.label,
          maxTests: target.maxTests,
          apiCallsSeenOnPage: target.apiCalls?.length ? target.apiCalls : undefined,
          apiResponses: target.page && !target.page.authGated && target.page.apiShapes
            ? Object.entries(target.page.apiShapes).slice(0, 3).map(([call, shape]) => ({ call, ...shape }))
            : undefined,
          observedBehaviors: target.page && !target.page.authGated && target.page.controlBehaviors?.length
            ? target.page.controlBehaviors.map((behavior) => ({
                control: behavior.control, valueTried: behavior.valueTried,
                requestsFired: behavior.requestsFired.length ? behavior.requestsFired : undefined,
                after: behavior.after ? { label: behavior.after.control.label, valueTried: behavior.after.valueTried } : undefined,
                apiResponse: behavior.responseShape
                  ? { call: behavior.responseCall ?? behavior.requestsFired.at(-1)?.replace(/^GET\s+/, ""), ...behavior.responseShape }
                  : undefined,
                appeared: behavior.appeared.slice(0, 8), disappeared: behavior.disappeared.slice(0, 8), kept: behavior.kept?.slice(0, 6)
              }))
            : undefined,
          parameters: [...target.url.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]),
          page: target.page && !target.page.authGated ? {
            title: target.page.title,
            headings: target.page.headings,
            buttons: target.page.buttons,
            clickables: target.page.clickables,
            navItems: target.page.navItems,
            inputs: target.page.inputs,
            labelPairs: target.page.labelPairs,
            selects: target.page.selects,
            pageText: target.page.pageText
          } : undefined,
          codeBehavior: target.code.slice(0, 6).map((entry) => ({
            component: entry.component,
            controls: entry.renderedElements.filter((element) => element.label && !/[{}$]/.test(element.label)).slice(0, 15).map((element) => ({ kind: element.kind, label: element.label, onClick: element.onClickHandler })),
            handlers: entry.handlers.slice(0, 8).map((handler) => ({ handler: handler.handler, apiCalls: handler.apiCalls.slice(0, 3), navigations: handler.navigations.slice(0, 3) }))
          }))
        }))
      });
      try {
        const response = await ledger.run<{ candidates?: CandidateDraft[] }>(impl, {
          organizationId: "", projectId: "", jobId: "generation",
          capability: "test-generation",
          systemPrompt,
          prompt,
          schemaName: "CandidateList",
          schema: {},
          temperature: 0
        });
        all.push(...(Array.isArray(response.output?.candidates) ? response.output.candidates : []));
      } catch (batchError) {
        failedBatches += 1;
        this.logger.warn(`Generation batch failed (${batchError instanceof Error ? batchError.message : batchError}); continuing with ${batches.length - failedBatches} remaining`);
      }
    }
    // An empty answer is valid now (the model was told to skip what it cannot ground); only total failure falls back.
    if (failedBatches === batches.length) throw new Error(`all ${failedBatches} generation batches failed`);
    void providerName;
    void providerModel;
    return all;
  }

  private resolveProvider() {
    return resolveModelProvider(this.prisma);
  }

  private estimateTokens(targets: Array<{ capability: string; route?: string }>, realProvider: boolean) {
    if (!realProvider) return 0;
    return targets.length * 1_200;
  }

  /** Decrypted Playwright storageState from the environment's last successful login, if any. Duplicated in AnalysisService; lift into a shared helper if a third caller needs it. */
  private normalizeTitle(title: string) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
}
