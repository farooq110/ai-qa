import { BadRequestException } from "@nestjs/common";
import { githubHeaders, type ProviderName } from "../repository-connections/repository-connections.service";

/** Token + API host for one project's repository (from RepositoryConnectionsService.projectAccess). */
export interface ProviderAccess { provider: ProviderName; repository: string; token: string; gitlabApi: string }

/** Provider-neutral state of a CI run, mapped to each provider's vocabulary when reported. */
export type ReportState = "queued" | "running" | "passed" | "failed" | "canceled" | "skipped";
export interface Report { state: ReportState; name: string; key: string; description: string; detailsUrl: string; commitSha: string; checkId: string | null; externalId: string }

async function call<T>(access: ProviderAccess, method: string, url: string, body?: unknown): Promise<T> {
  const headers = access.provider === "GITHUB" ? githubHeaders(access.token) : { Authorization: `Bearer ${access.token}`, Accept: "application/json" };
  const response = await fetch(url, { method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new BadRequestException(`${access.provider.toLowerCase()} ${method} ${new URL(url).pathname} failed with ${response.status}: ${detail}`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const gitlabProject = (access: ProviderAccess) => `${access.gitlabApi}/projects/${encodeURIComponent(access.repository)}`;

/** Registers the repository webhook for GitLab (deployment + pipeline events) or Bitbucket (build statuses). Returns its id. */
export async function createHook(access: ProviderAccess, url: string, secret: string): Promise<string> {
  if (access.provider === "GITLAB") {
    const hook = await call<{ id: number }>(access, "POST", `${gitlabProject(access)}/hooks`, { url, token: secret, deployment_events: true, pipeline_events: true, push_events: false, enable_ssl_verification: true });
    return String(hook.id);
  }
  if (access.provider === "BITBUCKET") {
    const hook = await call<{ uuid: string }>(access, "POST", `https://api.bitbucket.org/2.0/repositories/${access.repository}/hooks`, { description: "Proofline CI", url, active: true, secret, events: ["repo:commit_status_created", "repo:commit_status_updated"] });
    return hook.uuid;
  }
  throw new BadRequestException("GitHub repositories use the app-level webhook");
}

export async function deleteHook(access: ProviderAccess, hookId: string) {
  if (access.provider === "GITLAB") await call(access, "DELETE", `${gitlabProject(access)}/hooks/${encodeURIComponent(hookId)}`);
  else if (access.provider === "BITBUCKET") await call(access, "DELETE", `https://api.bitbucket.org/2.0/repositories/${access.repository}/hooks/${encodeURIComponent(hookId)}`);
}

/** Names of the repository's active GitHub Actions workflows (needs the app's Actions: read permission). */
export async function listWorkflows(access: ProviderAccess): Promise<string[]> {
  const page = await call<{ workflows: Array<{ name: string; state: string }> }>(access, "GET", `https://api.github.com/repos/${access.repository}/actions/workflows?per_page=100`);
  return page.workflows.filter((workflow) => workflow.state === "active").map((workflow) => workflow.name);
}

/** Open PR/MR number this commit belongs to, if any. */
export async function openPullRequestFor(access: ProviderAccess, sha: string): Promise<number | null> {
  if (access.provider === "GITHUB") {
    const pulls = await call<Array<{ number: number; state: string }>>(access, "GET", `https://api.github.com/repos/${access.repository}/commits/${sha}/pulls`);
    return pulls.find((pull) => pull.state === "open")?.number ?? null;
  }
  if (access.provider === "GITLAB") {
    const requests = await call<Array<{ iid: number; state: string }>>(access, "GET", `${gitlabProject(access)}/repository/commits/${sha}/merge_requests`);
    return requests.find((request) => request.state === "opened")?.iid ?? null;
  }
  return null;
}

/** Some deploy platforms set the deployment ref to the commit SHA; resolve the branch whose head it is. */
export async function githubBranchForSha(access: ProviderAccess, sha: string): Promise<string | null> {
  const branches = await call<Array<{ name: string }>>(access, "GET", `https://api.github.com/repos/${access.repository}/commits/${sha}/branches-where-head`);
  return branches[0]?.name ?? null;
}

/** Creates or updates the commit check/status. Returns the GitHub check run id (null elsewhere). */
export async function postReport(access: ProviderAccess, report: Report): Promise<string | null> {
  const description = report.description.slice(0, 140);
  if (access.provider === "GITHUB") {
    const done = !["queued", "running"].includes(report.state);
    const conclusion = { passed: "success", failed: "failure", canceled: "cancelled", skipped: "neutral" }[report.state as "passed"];
    const body = {
      name: report.name, details_url: report.detailsUrl, external_id: report.externalId,
      status: done ? "completed" : report.state === "running" ? "in_progress" : "queued",
      ...(done ? { conclusion, completed_at: new Date().toISOString() } : {}),
      output: { title: description, summary: description }
    };
    const check = report.checkId
      ? await call<{ id: number }>(access, "PATCH", `https://api.github.com/repos/${access.repository}/check-runs/${report.checkId}`, body)
      : await call<{ id: number }>(access, "POST", `https://api.github.com/repos/${access.repository}/check-runs`, { ...body, head_sha: report.commitSha });
    return String(check.id);
  }
  if (access.provider === "GITLAB") {
    // Commit statuses have no neutral state: a skip reports success so our side never blocks a merge.
    const state = { queued: "pending", running: "running", passed: "success", failed: "failed", canceled: "canceled", skipped: "success" }[report.state];
    const query = new URLSearchParams({ state, name: report.name, target_url: report.detailsUrl, description });
    try {
      await call(access, "POST", `${gitlabProject(access)}/statuses/${report.commitSha}?${query}`);
    } catch (error) {
      // GitLab rejects re-posting the state a status is already in ("Cannot transition status"); that is a no-op for us.
      if (!(error instanceof BadRequestException && /transition/i.test(error.message))) throw error;
    }
    return null;
  }
  const state = { queued: "INPROGRESS", running: "INPROGRESS", passed: "SUCCESSFUL", failed: "FAILED", canceled: "STOPPED", skipped: "SUCCESSFUL" }[report.state];
  await call(access, "POST", `https://api.bitbucket.org/2.0/repositories/${access.repository}/commit/${report.commitSha}/statuses/build`, { key: report.key, state, name: report.name, url: report.detailsUrl, description });
  return null;
}
