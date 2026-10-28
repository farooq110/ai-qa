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

/**
 * Phase 4: a typed, source-anchored description of one module's actions, built by the LLM from a
 * code slice and verified deterministically (every `src` quote must appear in that module's slice
 * file; every literal in a fact must appear inside one of its quotes). Shaped for OpenAI's strict
 * JSON-schema mode: every key required, `null` instead of an optional field, no extra properties -
 * the matching JSON Schema lives next to its only caller, apps/api/src/analysis/specs.ts.
 */
export interface SourceQuote { file: string; quote: string }

export interface FlowSpecEntity { name: string; statuses: Array<{ value: string; label: string }> }

export interface FlowSpecPrecondition {
  kind: string;
  entity: string;
  values: string[];
  description: string;
  enforcedBy: "client" | "server";
}

export interface FlowSpecFormRule { id: string; kind: string; value: string | null; message: string; layer: "client" | "server" }
/** `options`: choices literally written in the code (static list/enum); empty when loaded at runtime. */
export interface FlowSpecFormField { name: string; label: string; control: string; rules: FlowSpecFormRule[]; options?: string[] }
export interface FlowSpecCall { method: string; path: string; endpointId: string | null }
export interface FlowSpecBackendRule { id: string; condition: string; message: string; reproducibleViaUi: boolean }
export interface FlowSpecEffect { kind: "transition" | "message" | "navigate" | "list-change" | "field-change"; entity: string | null; from: string[]; to: string | null; text: string | null; route: string | null }

export interface FlowSpecAction {
  id: string;
  name: string;
  kind: string;
  trigger: { route: string; label: string; control: string; container: string };
  /** The button that saves/confirms the form or dialog the trigger opens; null when the trigger itself performs the action. */
  submit?: { label: string } | null;
  /** The trigger is repeated per record of a list/table/card grid and acts on that one record (Edit, Delete, View on a row). */
  rowScoped?: boolean;
  preconditions: FlowSpecPrecondition[];
  permission: { value: string; enforcedBy: "client" | "server" } | null;
  form: FlowSpecFormField[];
  calls: FlowSpecCall[];
  backendRules: FlowSpecBackendRule[];
  effects: FlowSpecEffect[];
  src: SourceQuote[];
}

export interface FlowSpecData {
  module: { key: string; name: string; summary: string };
  routes: string[];
  entities: FlowSpecEntity[];
  navigation: string[];
  actions: FlowSpecAction[];
}