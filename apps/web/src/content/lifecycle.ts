export type LifecycleTone = "ai" | "pending" | "approve" | "change" | "neutral";

export type LifecycleStage = {
  readonly id: string;
  readonly state: string;
  readonly tone: LifecycleTone;
  readonly title: string;
  readonly body: string;
  readonly runnable: boolean;
  readonly version: string;
  /** Synthetic audit-log entries this stage appends to the demo card. */
  readonly log: readonly { readonly text: string; readonly tone: LifecycleTone }[];
};

export const lifecycle = {
  heading: "Approval is the gate, not a suggestion.",
  intro:
    "Every generated test walks the same path. The run button only exists for a version a human has approved, and an edit sends it back for review as a new version.",
  stages: [
    {
      id: "generated",
      state: "Generated",
      tone: "ai",
      title: "Drafted from your code, not from a prompt.",
      body: "Candidates come from a pinned commit: static analysis plus controlled browser discovery, turned into a versioned model of your application.",
      runnable: false,
      version: "v1",
      log: [{ text: "Proofline generated v1 from commit 3f9c2ad", tone: "ai" }]
    },
    {
      id: "pending",
      state: "Pending review",
      tone: "pending",
      title: "Queued for a person, with its evidence.",
      body: "Reviewers see the steps, the source files and routes behind them, a confidence score, and what the test covers.",
      runnable: false,
      version: "v1",
      log: [
        { text: "Review requested from QA", tone: "pending" },
        { text: "CI tried to run v1 · blocked, version not approved", tone: "change" }
      ]
    },
    {
      id: "edited",
      state: "Edited · v2",
      tone: "pending",
      title: "Change a step, get a new version.",
      body: "Edits never rewrite history. The new version goes back to Pending review; earlier runs stay attached to the version that produced them.",
      runnable: false,
      version: "v2",
      log: [{ text: "S. Kral edited step 3 · v2 sent back to review", tone: "pending" }]
    },
    {
      id: "approved",
      state: "Approved",
      tone: "approve",
      title: "One approval unlocks this exact version.",
      body: "Approval is recorded against the version, the reviewer, and the time. Rejected and archived candidates never reach a runner.",
      runnable: true,
      version: "v2",
      log: [{ text: "M. Ortiz approved v2", tone: "approve" }]
    },
    {
      id: "running",
      state: "Running",
      tone: "neutral",
      title: "Executed by Playwright, in isolation.",
      body: "Approved versions run in resource-limited workers. Membership, permission, billing and approval are checked again right before work begins.",
      runnable: true,
      version: "v2",
      log: [{ text: "Queued on 3 shards · chromium · commit 3f9c2ad", tone: "neutral" }]
    },
    {
      id: "passed",
      state: "Passed",
      tone: "approve",
      title: "Results with everything you need to trust them.",
      body: "Logs, screenshots, videos and traces stay with the run, recorded against the branch and commit it ran on.",
      runnable: true,
      version: "v2",
      log: [{ text: "Passed in 1m 55s · trace, video and screenshots saved", tone: "approve" }]
    }
  ] satisfies LifecycleStage[]
} as const;
