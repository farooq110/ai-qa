import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma, type CiTriggerMode, type Project } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { recordAudit } from "../common/audit";
import { subscriptionContext } from "../common/billing-context";
import { decryptField, encryptField } from "../common/crypto.util";
import { enqueueCiReport, enqueueExecution } from "../common/queue";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PermissionsService } from "../rbac/permissions.service";
import { RepositoryConnectionsService } from "../repository-connections/repository-connections.service";
import { PERMISSIONS } from "@ai-qa/domain";
import { createHook, deleteHook, githubBranchForSha, listWorkflows, openPullRequestFor, type ProviderAccess } from "./provider-api";

export interface BranchRule { pattern: string; environmentId?: string }
interface CiSettingsInput { enabled?: unknown; triggerMode?: unknown; workflowName?: unknown; branchRules?: unknown; pullRequests?: unknown; environmentFilter?: unknown; bypassHeaders?: unknown }
/** An access header for a protected deployment; the value is AES-256-GCM sealed and never returned. */
export interface StoredHeader { name: string; enc: string; iv: string; tag: string }
/** A provider event saying `commitSha` on `branch` is live (GitHub/GitLab: at environmentUrl). */
interface DeployEvent { deliveryKey: string; branch: string; commitSha: string; environmentName: string; environmentUrl: string }

const MAX_RULES = 20;
const MAX_HEADERS = 5;
/** Headers that would break the request or replace the app's own session; never overridable. */
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "connection", "transfer-encoding", "upgrade", "cookie", "set-cookie"]);
const SHA = /^[0-9a-f]{40}$/i;

@Injectable()
export class CiService {
  private readonly logger = new Logger(CiService.name);

  constructor(private readonly prisma: PrismaService, private readonly permissions: PermissionsService, private readonly connections: RepositoryConnectionsService) {}

  async getSettings(user: AuthenticatedUser, projectId: string) {
    const project = await this.requireProject(user, projectId);
    return {
      provider: project.provider,
      imported: Boolean(project.repositoryConnectionId),
      enabled: project.ciEnabled,
      triggerMode: triggerMode(project),
      workflowName: project.ciWorkflowName,
      branchRules: parseRules(project.ciBranchRules),
      pullRequests: project.ciPullRequests,
      environmentFilter: project.ciEnvironmentFilter,
      bypassHeaders: parseHeaders(project.ciBypassHeaders).map((header) => ({ name: header.name })),
      webhookRegistered: project.provider === "GITHUB" ? project.ciEnabled : Boolean(project.ciHookId)
    };
  }

  async saveSettings(user: AuthenticatedUser, projectId: string, input: CiSettingsInput) {
    await this.permissions.assert(user, PERMISSIONS.CI_CD_EDIT);
    const project = await this.requireProject(user, projectId);
    const enabled = input.enabled === true;
    const mode: CiTriggerMode = project.provider === "BITBUCKET" ? "PIPELINE" : input.triggerMode === "PIPELINE" ? "PIPELINE" : input.triggerMode === "DEPLOYMENT" ? "DEPLOYMENT" : project.ciTriggerMode;
    const branchRules = await this.validateRules(project, mode, input.branchRules);
    // Preview deployments only exist in DEPLOYMENT mode; a pipeline run has no preview URL to test.
    const pullRequests = input.pullRequests === true && mode === "DEPLOYMENT" && project.provider !== "BITBUCKET";
    const environmentFilter = typeof input.environmentFilter === "string" ? input.environmentFilter.trim() : "";
    const workflowName = typeof input.workflowName === "string" ? input.workflowName.trim() : project.ciWorkflowName;
    const storedHeaders = parseHeaders(project.ciBypassHeaders);
    const bypassHeaders = input.bypassHeaders === undefined ? storedHeaders : sealHeaders(input.bypassHeaders, storedHeaders, this.encryptionSecret());
    if (environmentFilter.length > 100 || workflowName.length > 100) throw new BadRequestException("Environment filter or workflow name is too long");
    if (enabled && mode === "PIPELINE" && project.provider === "GITHUB" && !workflowName) throw new BadRequestException("Pick the workflow whose success means the app is deployed, e.g. Deploy");
    if (enabled && !project.repositoryConnectionId) throw new BadRequestException("This project was created from a pasted URL. Import the repository again from Projects → Import repository to enable CI.");
    if (enabled && !branchRules.length && !pullRequests) throw new BadRequestException("Pick at least one branch or turn on PR previews");

    if (enabled && project.provider === "GITHUB") await this.assertGithubDelivers(project, mode);

    let hook: Pick<Project, "ciHookId" | "ciHookSecretCiphertext" | "ciHookSecretIv" | "ciHookSecretTag"> | null = null;
    if (enabled && project.provider === "GITHUB" && !process.env.GITHUB_APP_WEBHOOK_SECRET) throw new BadRequestException("GitHub CI is not configured on this server (GITHUB_APP_WEBHOOK_SECRET is missing).");
    if (enabled && project.provider !== "GITHUB" && !project.ciHookId) hook = await this.registerHook(project);
    if (!enabled && project.ciHookId) {
      await this.removeHook(project);
      hook = { ciHookId: null, ciHookSecretCiphertext: null, ciHookSecretIv: null, ciHookSecretTag: null };
    }

    await this.prisma.project.update({
      where: { id: project.id },
      data: { ciEnabled: enabled, ciTriggerMode: mode, ciWorkflowName: workflowName, ciBranchRules: branchRules as unknown as Prisma.InputJsonValue, ciPullRequests: pullRequests, ciEnvironmentFilter: environmentFilter, ciBypassHeaders: bypassHeaders as unknown as Prisma.InputJsonValue, ...(hook ?? {}) }
    });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "ci.settings_updated", targetType: "Project", targetId: project.id, metadata: { enabled, mode, branches: branchRules.map((rule) => rule.pattern), pullRequests, environmentFilter, workflowName, bypassHeaders: bypassHeaders.map((header) => header.name) } });
    return this.getSettings(user, projectId);
  }

  /** Workflow names for the GitHub PIPELINE-mode picker. Empty when the app lacks Actions: read — the UI falls back to typing. */
  async listWorkflows(user: AuthenticatedUser, projectId: string) {
    const project = await this.requireProject(user, projectId);
    if (project.provider !== "GITHUB" || !project.repositoryConnectionId) return [];
    try {
      return await listWorkflows(await this.access(project));
    } catch {
      return [];
    }
  }

  async listRuns(user: AuthenticatedUser, projectId: string) {
    await this.requireProject(user, projectId);
    const runs = await this.prisma.ciRun.findMany({
      where: { projectId }, orderBy: { createdAt: "desc" }, take: 5,
      include: { executionPlan: { select: { id: true, status: true, items: { select: { status: true } } } } }
    });
    return runs.map(({ executionPlan, ...run }) => ({
      ...run,
      plan: executionPlan && { id: executionPlan.id, status: executionPlan.status, total: executionPlan.items.length, passed: executionPlan.items.filter((item) => item.status === "PASSED").length, failed: executionPlan.items.filter((item) => item.status === "FAILED").length }
    }));
  }

  /** Best effort: the repository may already be gone or the token revoked — never block a delete on it. */
  async removeHook(project: Project) {
    if (!project.ciHookId) return;
    try {
      await deleteHook(await this.access(project), project.ciHookId);
    } catch (error) {
      this.logger.warn(`Could not remove CI webhook ${project.ciHookId} from ${project.repoFullName}: ${error instanceof Error ? error.message : error}`);
    }
  }

  // ---------- Webhooks ----------

  async handleGithub(rawBody: Buffer | undefined, signature: string | undefined, event: string | undefined, payload: GithubPayload) {
    if (!verifyHmac(process.env.GITHUB_APP_WEBHOOK_SECRET, rawBody, signature)) throw new ForbiddenException("Invalid webhook signature");
    if (event === "installation" && payload.action === "deleted" && payload.installation) {
      // The customer uninstalled the app on GitHub: its connection can never mint tokens again.
      await this.prisma.repositoryConnection.deleteMany({ where: { provider: "GITHUB", installationId: String(payload.installation.id) } });
      return { handled: "installation.deleted" };
    }
    if (!payload.repository) return { ignored: event };
    const repoId = String(payload.repository.id);

    if (event === "deployment_status" && payload.deployment_status?.state === "success" && payload.deployment) {
      const { deployment, deployment_status: status } = payload;
      const projects = await this.prisma.project.findMany({ where: { provider: "GITHUB", externalRepoId: repoId, ciEnabled: true, ciTriggerMode: "DEPLOYMENT" } });
      for (const project of projects) {
        await this.safely(project, async () => {
          const branch = SHA.test(deployment.ref) ? await githubBranchForSha(await this.access(project), deployment.ref) ?? deployment.ref : deployment.ref;
          await this.trigger(project, { deliveryKey: `deployment_status:${status.id}`, branch, commitSha: deployment.sha, environmentName: deployment.environment ?? "", environmentUrl: status.environment_url || status.target_url || "" });
        });
      }
      return { projects: projects.length };
    }

    // PIPELINE mode: the chosen workflow finished successfully on a branch → test that branch's mapped environment.
    const run = payload.workflow_run;
    if (event === "workflow_run" && payload.action === "completed" && run?.conclusion === "success" && run.head_branch) {
      // A pull-request workflow's commit is not what is deployed at the fixed URL.
      if (run.event === "pull_request" || run.event === "pull_request_target") return { ignored: "pull request workflow" };
      const projects = await this.prisma.project.findMany({ where: { provider: "GITHUB", externalRepoId: repoId, ciEnabled: true, ciTriggerMode: "PIPELINE" } });
      for (const project of projects) {
        if (!project.ciWorkflowName || !globMatch(project.ciWorkflowName, run.name ?? "")) continue;
        await this.safely(project, () => this.trigger(project, { deliveryKey: `workflow_run:${run.id}:${run.run_attempt ?? 1}`, branch: run.head_branch!, commitSha: run.head_sha, environmentName: "", environmentUrl: "" }));
      }
      return { projects: projects.length };
    }
    return { ignored: event };
  }

  async handleGitlab(projectId: string, token: string | undefined, payload: GitlabPayload) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, provider: "GITLAB" } });
    if (!project || !token || !secretMatches(this.hookSecret(project), token)) throw new ForbiddenException("Invalid webhook token");
    if (!project.ciEnabled) return { ignored: "ci disabled" };

    if (payload.object_kind === "deployment" && project.ciTriggerMode === "DEPLOYMENT" && payload.status === "success") {
      const commitSha = payload.commit_url?.match(/\/commit\/([0-9a-f]{40})/i)?.[1];
      if (!commitSha || !payload.ref) return { ignored: "deployment without commit" };
      await this.safely(project, () => this.trigger(project, { deliveryKey: `deployment:${payload.deployment_id}`, branch: payload.ref!, commitSha, environmentName: payload.environment ?? "", environmentUrl: payload.environment_external_url ?? "" }));
      return { handled: true };
    }

    if (payload.object_kind === "pipeline" && project.ciTriggerMode === "PIPELINE") {
      const pipeline = payload.object_attributes;
      // Merge-request, child and tag pipelines are not "the branch was deployed".
      if (!pipeline || pipeline.status !== "success" || pipeline.tag || payload.merge_request || pipeline.source === "merge_request_event" || pipeline.source === "parent_pipeline" || !pipeline.ref || !pipeline.sha) return { ignored: "pipeline" };
      await this.safely(project, () => this.trigger(project, { deliveryKey: `pipeline:${pipeline.id}`, branch: pipeline.ref!, commitSha: pipeline.sha!, environmentName: "", environmentUrl: "" }));
      return { handled: true };
    }
    return { ignored: payload.object_kind };
  }

  async handleBitbucket(projectId: string, rawBody: Buffer | undefined, signature: string | undefined, event: string | undefined, payload: BitbucketPayload) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, provider: "BITBUCKET" } });
    if (!project || !verifyHmac(this.hookSecret(project), rawBody, signature)) throw new ForbiddenException("Invalid webhook signature");
    const status = payload.commit_status;
    // Only a finished Bitbucket Pipelines build means "deployed" — ignore other tools' statuses and our own.
    if (!event?.startsWith("repo:commit_status_") || !status || status.state !== "SUCCESSFUL" || status.key?.startsWith("proofline") || !/pipelines/i.test(status.url ?? "") || !status.refname || !status.commit?.hash || !project.ciEnabled) return { ignored: event };
    await this.safely(project, () => this.trigger(project, { deliveryKey: `status:${status.commit!.hash}:${status.key}`, branch: status.refname!, commitSha: status.commit!.hash, environmentName: "", environmentUrl: "" }));
    return { handled: true };
  }

  /**
   * Applies the project's CI rules to one deploy event, then queues all approved tests against the deployed
   * URL, cancelling older runs of the same branch. Every outcome — including "skipped" — is reported back.
   */
  private async trigger(project: Project, event: DeployEvent) {
    const mode = triggerMode(project);
    if (mode === "DEPLOYMENT" && project.ciEnvironmentFilter && !globMatch(project.ciEnvironmentFilter, event.environmentName)) return;
    const rule = parseRules(project.ciBranchRules).find((candidate) => globMatch(candidate.pattern, event.branch));
    let pullRequest: number | null = null;
    if (!rule) {
      if (mode !== "DEPLOYMENT" || !project.ciPullRequests) return;
      pullRequest = await openPullRequestFor(await this.access(project), event.commitSha);
      if (!pullRequest) return;
    }

    let environmentUrl = event.environmentUrl;
    let skipReason: string | null = null;
    if (mode === "PIPELINE") {
      const environment = rule?.environmentId ? await this.prisma.environmentProfile.findFirst({ where: { id: rule.environmentId, projectId: project.id } }) : null;
      environmentUrl = environment?.url ?? "";
      if (!environment) skipReason = `No environment is mapped to ${event.branch} any more`;
    } else if (!/^https?:\/\//i.test(environmentUrl)) {
      skipReason = "The deployment did not include a URL";
    }

    let run;
    try {
      run = await this.prisma.ciRun.create({
        data: { projectId: project.id, provider: project.provider, deliveryKey: event.deliveryKey, branch: event.branch, commitSha: event.commitSha, pullRequest, environmentName: event.environmentName, environmentUrl }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return; // Redelivered webhook.
      throw error;
    }

    const billing = await subscriptionContext(this.prisma, project.organizationId);
    if (!skipReason && (billing.billingLocked || billing.status === "INCOMPLETE")) skipReason = `Billing is ${billing.status.toLowerCase().replace("_", " ")}`;
    const approved = skipReason ? [] : await this.prisma.testCase.findMany({ where: { projectId: project.id, status: "APPROVED" }, select: { id: true } });
    if (!skipReason && !approved.length) skipReason = "No approved tests yet";
    if (skipReason) {
      await this.prisma.ciRun.update({ where: { id: run.id }, data: { status: "SKIPPED", reason: skipReason } });
      await enqueueCiReport({ ciRunId: run.id });
      return;
    }

    await this.supersede(project.id, event.branch, run.id, event.commitSha);
    const plan = await this.prisma.executionPlan.create({
      data: {
        organizationId: project.organizationId, projectId: project.id, branch: event.branch, commitSha: event.commitSha, environmentUrl, trigger: "CI",
        items: { create: approved.map((test) => ({ testCaseId: test.id })) }
      }
    });
    await this.prisma.ciRun.update({ where: { id: run.id }, data: { executionPlanId: plan.id } });
    await enqueueExecution(plan.id);
    await enqueueCiReport({ ciRunId: run.id });
    await recordAudit(this.prisma, {
      organizationId: project.organizationId, action: "ci.execution_queued", targetType: "ExecutionPlan", targetId: plan.id,
      metadata: { provider: project.provider, branch: event.branch, commitSha: event.commitSha, pullRequest, environmentUrl, tests: approved.length }
    });
  }

  /** Only the newest commit of a branch matters: cancel its still-pending older runs. */
  private async supersede(projectId: string, branch: string, keepRunId: string, commitSha: string) {
    const older = await this.prisma.ciRun.findMany({ where: { projectId, branch, status: { in: ["QUEUED", "RUNNING"] }, id: { not: keepRunId } }, select: { id: true, executionPlanId: true } });
    for (const run of older) {
      if (run.executionPlanId) {
        await this.prisma.executionPlan.updateMany({ where: { id: run.executionPlanId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELED", completedAt: new Date() } });
      }
      await this.prisma.ciRun.update({ where: { id: run.id }, data: { status: "CANCELED", reason: `Superseded by ${commitSha.slice(0, 7)}` } });
      await enqueueCiReport({ ciRunId: run.id });
    }
  }

  /**
   * GitHub drops events silently when the app isn't subscribed or the installation hasn't approved the
   * permission, and nothing on our side would ever show it. Refuse to enable CI on a setup that cannot fire.
   */
  private async assertGithubDelivers(project: Project, mode: CiTriggerMode) {
    const need = mode === "PIPELINE"
      ? { event: "workflow_run", eventLabel: "Workflow run", permission: "actions", permissionLabel: "Actions: Read-only" }
      : { event: "deployment_status", eventLabel: "Deployment status", permission: "deployments", permissionLabel: "Deployments: Read-only" };
    let info;
    try {
      info = await this.connections.githubInstallationInfo(project);
    } catch (error) {
      this.logger.warn(`Could not verify GitHub delivery for ${project.repoFullName}: ${error instanceof Error ? error.message : error}`);
      return; // GitHub being unreachable must not block saving settings.
    }
    if (!info) return;
    const problems: string[] = [];
    if (!info.webhookUrl) problems.push("turn the webhook on and set its URL to {PUBLIC_API_URL}/v1/webhooks/github");
    if (!info.permissions[need.permission]) problems.push(`give the app the permission ${need.permissionLabel}`);
    if (!info.events.includes(need.event)) problems.push(`subscribe the app to the ${need.eventLabel} event`);
    if (problems.length) {
      throw new BadRequestException(`GitHub will not send this repository's ${mode === "PIPELINE" ? "workflow runs" : "deployments"} yet. In the GitHub App settings: ${problems.join("; ")}. Then open the installation (github.com/settings/installations) and accept the new permissions.`);
    }
  }

  private async registerHook(project: Project) {
    const publicApi = process.env.PUBLIC_API_URL?.trim().replace(/\/+$/, "");
    if (!publicApi) throw new BadRequestException("CI webhooks are not configured on this server (PUBLIC_API_URL is missing).");
    const secret = randomBytes(32).toString("hex");
    const url = `${publicApi}/v1/webhooks/${project.provider.toLowerCase()}/${project.id}`;
    let hookId: string;
    try {
      hookId = await createHook(await this.access(project), url, secret);
    } catch (error) {
      const role = project.provider === "GITLAB" ? "Maintainer" : "Admin";
      throw new BadRequestException(`Could not add the webhook to ${project.repoFullName}. The connected account needs ${role} access to the repository. (${error instanceof Error ? error.message : error})`);
    }
    const sealed = encryptField(secret, this.encryptionSecret());
    return { ciHookId: hookId, ciHookSecretCiphertext: sealed.enc, ciHookSecretIv: sealed.iv, ciHookSecretTag: sealed.tag };
  }

  private hookSecret(project: Project) {
    if (!project.ciHookSecretCiphertext || !project.ciHookSecretIv || !project.ciHookSecretTag) return undefined;
    return decryptField({ enc: project.ciHookSecretCiphertext, iv: project.ciHookSecretIv, tag: project.ciHookSecretTag }, this.encryptionSecret());
  }

  private encryptionSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET is required");
    return secret;
  }

  async access(project: Pick<Project, "organizationId" | "provider" | "repositoryConnectionId" | "repoFullName">): Promise<ProviderAccess> {
    const { token, gitlabApi } = await this.connections.projectAccess(project);
    return { provider: project.provider, repository: project.repoFullName, token, gitlabApi };
  }

  /** One project's failure (revoked token, provider outage) must not fail the webhook for the others. */
  private async safely(project: Project, work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      this.logger.error(`CI trigger failed for project ${project.id} (${project.repoFullName}): ${error instanceof Error ? error.message : error}`);
    }
  }

  /** PIPELINE rules must name the environment to test; DEPLOYMENT rules take the URL from the deployment instead. */
  private async validateRules(project: Project, mode: CiTriggerMode, value: unknown): Promise<BranchRule[]> {
    const entries = value === undefined ? parseRules(project.ciBranchRules) : value;
    if (!Array.isArray(entries) || entries.length > MAX_RULES) throw new BadRequestException(`branchRules must be a list of at most ${MAX_RULES} branches`);
    const rules: BranchRule[] = [];
    for (const entry of entries as Array<{ pattern?: unknown; environmentId?: unknown }>) {
      const pattern = typeof entry?.pattern === "string" ? entry.pattern.trim() : "";
      if (!/^[\w./*@+-]{1,100}$/.test(pattern)) throw new BadRequestException(`"${pattern}" is not a valid branch name or pattern`);
      if (rules.some((rule) => rule.pattern === pattern)) continue;
      if (mode === "PIPELINE") {
        const environmentId = typeof entry.environmentId === "string" ? entry.environmentId : "";
        const environment = environmentId ? await this.prisma.environmentProfile.findFirst({ where: { id: environmentId, projectId: project.id }, select: { id: true } }) : null;
        if (!environment) throw new BadRequestException(`Pick the environment to test when ${pattern} passes its pipeline`);
        rules.push({ pattern, environmentId });
      } else {
        rules.push({ pattern });
      }
    }
    return rules;
  }

  private async requireProject(user: AuthenticatedUser, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    return project;
  }
}

export function parseHeaders(value: Prisma.JsonValue): StoredHeader[] {
  return Array.isArray(value) ? (value as unknown as StoredHeader[]).filter((header) => typeof header?.name === "string" && typeof header.enc === "string") : [];
}

/** Validates the submitted headers and seals their values. A row without a value keeps the stored value of the same name. */
export function sealHeaders(input: unknown, existing: StoredHeader[], secret: string): StoredHeader[] {
  if (!Array.isArray(input) || input.length > MAX_HEADERS) throw new BadRequestException(`Add at most ${MAX_HEADERS} access headers`);
  const sealed: StoredHeader[] = [];
  for (const entry of input as Array<{ name?: unknown; value?: unknown }>) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new BadRequestException(`"${name}" is not a usable header name`);
    if (sealed.some((header) => header.name.toLowerCase() === name.toLowerCase())) throw new BadRequestException(`The ${name} header is listed twice`);
    const value = typeof entry.value === "string" ? entry.value.trim() : "";
    if (value) {
      if (value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new BadRequestException(`The value of ${name} is too long or contains control characters`);
      const box = encryptField(value, secret);
      sealed.push({ name, enc: box.enc, iv: box.iv, tag: box.tag });
    } else {
      const kept = existing.find((header) => header.name.toLowerCase() === name.toLowerCase());
      if (!kept) throw new BadRequestException(`Enter a value for the ${name} header`);
      sealed.push({ ...kept, name });
    }
  }
  return sealed;
}

/** Bitbucket has no deployment events, so it is always PIPELINE. */
export function triggerMode(project: Pick<Project, "provider" | "ciTriggerMode">): CiTriggerMode {
  return project.provider === "BITBUCKET" ? "PIPELINE" : project.ciTriggerMode;
}

export function parseRules(value: Prisma.JsonValue): BranchRule[] {
  return Array.isArray(value) ? (value as unknown as BranchRule[]).filter((rule) => typeof rule?.pattern === "string") : [];
}

/** `*` matches any run of characters (including `/`); everything else is literal. Case-insensitive. */
export function globMatch(pattern: string, value: string) {
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "i").test(value);
}

/** GitHub (`X-Hub-Signature-256`) and Bitbucket (`X-Hub-Signature`) both send `sha256=<hex HMAC of the raw body>`. */
export function verifyHmac(secret: string | undefined, rawBody: Buffer | undefined, header: string | undefined) {
  if (!secret || !rawBody || !header?.startsWith("sha256=")) return false;
  return secretMatches(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`, header);
}

function secretMatches(expected: string | undefined, received: string) {
  if (!expected) return false;
  const [a, b] = [Buffer.from(expected), Buffer.from(received)];
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface GithubPayload {
  action?: string;
  installation?: { id: number };
  repository?: { id: number; full_name: string };
  deployment?: { sha: string; ref: string; environment?: string };
  deployment_status?: { id: number; state: string; environment_url?: string; target_url?: string };
  workflow_run?: { id: number; name?: string; conclusion?: string | null; head_branch?: string | null; head_sha: string; event?: string; run_attempt?: number };
}
export interface GitlabPayload {
  object_kind?: string; status?: string; deployment_id?: number; environment?: string; environment_external_url?: string; ref?: string; commit_url?: string;
  object_attributes?: { id: number; ref?: string; sha?: string; status?: string; source?: string; tag?: boolean };
  merge_request?: unknown;
}
export interface BitbucketPayload { commit_status?: { key?: string; state?: string; url?: string; refname?: string; commit?: { hash: string } } }
