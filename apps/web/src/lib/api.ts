"use client";

export const apiToken = {
  get: () => (typeof window === "undefined" ? null : window.localStorage.getItem("proofline.accessToken")),
  set: (token: string) => window.localStorage.setItem("proofline.accessToken", token),
  clear: () => window.localStorage.removeItem("proofline.accessToken")
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

export function shortSha(sha: string | null | undefined) {
  return sha ? sha.slice(0, 7) : "—";
}

export const statusLabels: Record<string, string> = {
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

export interface ProjectSummaryDto { id: string; name: string; repositoryUrl: string; defaultBranch: string; }

export async function listProjects(): Promise<ProjectSummaryDto[]> {
  return api<ProjectSummaryDto[]>("/v1/projects");
}
