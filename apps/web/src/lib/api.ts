"use client";

export const apiToken = {
  get: () => (typeof window === "undefined" ? null : window.localStorage.getItem("proofline.accessToken")),
  set: (token: string) => { window.sessionStorage.removeItem("proofline.me"); window.localStorage.setItem("proofline.accessToken", token); },
  clear: () => { window.sessionStorage.removeItem("proofline.me"); window.localStorage.removeItem("proofline.accessToken"); }
};

export const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = apiToken.get();
  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      apiToken.clear();
      window.location.assign("/signin");
    }
    throw new ApiError(response.status, (payload.message as string) ?? `Request failed with status ${response.status}`);
  }
  return payload as T;
}

export function fmtDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtRelative(value: string | Date | null | undefined) {
  if (!value) return "—";
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "today, 2:05 PM", "yesterday, 9:10 AM", "3 days ago", then a plain date: when something last happened, by calendar day. */
export function fmtDay(value: string | Date | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  const midnight = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(date)) / 86_400_000);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days <= 0) return `today, ${time}`;
  if (days === 1) return `yesterday, ${time}`;
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function shortSha(sha: string | null | undefined) {
  return sha ? sha.slice(0, 7) : "—";
}

export const statusLabels: Record<string, string> = {
  DRAFT: "Verifying",
  PENDING_REVIEW: "Pending review",
  APPROVED: "Approved",
  NEEDS_REVIEW: "Needs review",
  REJECTED: "Rejected",
  ARCHIVED: "Archived",
  QUEUED: "Queued",
  RUNNING: "Running",
  PASSED: "Passed",
  FAILED: "Failed",
  BLOCKED: "Blocked",
  CANCELED: "Canceled",
  SKIPPED: "Skipped",
  COMPLETED: "Completed",
  INCOMPLETE: "No plan",
  TRIALING: "Trialing",
  ACTIVE: "Active",
  PAYMENT_WARNING: "Payment warning",
  PAST_DUE: "Past due",
  BILLING_LOCKED: "Billing locked",
  EXPIRED: "Expired"
};

/** "PENDING_REVIEW" -> "pending-review" so enums map to CSS chip classes. */
export const statusClass = (status: string) => status.toLowerCase().replace(/_/g, "-");

export const categoryLabels: Record<string, string> = {
  HAPPY_PATH: "Happy path",
  NEGATIVE: "Negative",
  BOUNDARY: "Boundary",
  VALIDATION: "Validation",
  PERMISSION: "Permission",
  ERROR: "Error handling",
  STATE: "State change",
  INTEGRATION: "Integration"
};

export type RepositoryProviderName = "GITHUB" | "BITBUCKET" | "GITLAB";
export interface ProjectSummaryDto { id: string; name: string; provider: RepositoryProviderName; repoFullName: string; repositoryUrl: string; repositoryConnectionId: string | null; rootDirectory: string; backendDirectories: string[]; defaultBranch: string; }

export async function listProjects(): Promise<ProjectSummaryDto[]> {
  return api<ProjectSummaryDto[]>("/v1/projects");
}

export interface AnalysisRunDto {
  id: string; branch: string; commitSha: string; status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  errorMessage: string | null; completedAt: string | null; createdAt?: string;
  knowledgeModel?: { routes?: unknown[]; endpoints?: unknown[]; flowSpecs?: unknown[]; discoveryError?: string; routeSummary?: { total: number; verified: number; budgetHit: boolean }; codeLinks?: { pages: number; linked: number; unlinked: string[] } } | null;
}

/** One sentence for a finished analysis: what the live crawl reached, and what to do next. */
export function analysisOutcome(name: string, run: AnalysisRunDto): string {
  const summary = run.knowledgeModel?.routeSummary;
  const login = run.knowledgeModel?.discoveryError;
  const links = run.knowledgeModel?.codeLinks;
  // Pages with no source file get no feature description, so no tests: say which ones, not just how many.
  const unlinked = links?.unlinked.length ? ` ${links.linked} of ${links.pages} pages linked to their code; not linked (no tests for these): ${links.unlinked.slice(0, 6).join(", ")}${links.unlinked.length > 6 ? ` and ${links.unlinked.length - 6} more` : ""}.` : "";
  if (summary?.verified) return `${name}: ${summary.verified} of ${summary.total} pages opened in the live app${summary.budgetHit ? " (crawl budget reached; analyze again to continue)" : ""}.${unlinked}${login ? ` ${login}` : ""} You can now generate tests.`;
  if (login) return `${name}: analysis completed, but the live app could not be read: ${login}`;
  return `${name}: analysis completed, but no pages could be opened in the live app. Add an environment URL (and login if needed) in Settings.`;
}

/** Analysis runs in the background: poll its run until it finishes. Throws with the run's error when it failed. */
export async function waitForAnalysis(projectId: string, runId: string, timeoutMs = 15 * 60_000): Promise<AnalysisRunDto> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await api<AnalysisRunDto[]>(`/v1/projects/${projectId}/analysis`);
    const run = runs.find((entry) => entry.id === runId);
    if (run?.status === "COMPLETED") return run;
    if (run?.status === "FAILED") throw new Error(run.errorMessage ?? "Analysis failed");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("Analysis is still running. Check back in a few minutes.");
}

export interface GenerationRunDto {
  id: string; status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED";
  errorMessage: string | null; created: number | null; duplicatesSkipped: number | null;
  report?: { stage?: string; planned?: number; generated?: number; verified?: number; heldOut?: number; skipped?: Array<{ reason: string }> } | null;
}

/** Generation (draft + dry-run verification) runs in the background: poll it until it finishes. */
export async function waitForGeneration(projectId: string, generationId: string, timeoutMs = 20 * 60_000): Promise<GenerationRunDto> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await api<GenerationRunDto>(`/v1/projects/${projectId}/generations/${generationId}`);
    if (run.status === "COMPLETED") return run;
    if (run.status === "FAILED") throw new Error(run.errorMessage ?? "Generation failed");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("Generation is still running (drafting and verifying candidates). Check back shortly.");
}
