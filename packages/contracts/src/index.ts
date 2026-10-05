export type TestStatus = "PENDING_REVIEW" | "APPROVED" | "NEEDS_REVIEW" | "ARCHIVED";

export type TestRunStatus = "QUEUED" | "RUNNING" | "PASSED" | "FAILED" | "BLOCKED";

export interface ProjectSummary {
  id: string;
  name: string;
  repository: string;
  defaultBranch: string;
  environmentUrl: string;
}

export interface TestCaseSummary {
  id: string;
  title: string;
  module: string;
  status: TestStatus;
  priority: "Critical" | "High" | "Medium" | "Low";
  confidence: number;
}

export interface ExecutionRequest {
  projectId: string;
  testCaseIds: string[];
  branch: string;
  commitSha?: string;
  environmentId: string;
}