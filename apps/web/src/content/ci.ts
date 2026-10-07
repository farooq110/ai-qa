// Branch history values are synthetic demonstration data.

export type BranchResult = "pass" | "fail" | "env" | "none";

export const ci = {
  heading: "Every push runs what you approved, at the exact commit.",
  intro:
    "Your pipeline sends the repository, branch and commit SHA. Proofline validates the organization, pins the commit, and runs the approved snapshot. No generation happens in CI, so a run normally spends zero AI tokens.",
  pipeline: [
    { label: "Push", detail: "feature/checkout-v2" },
    { label: "Pipeline calls Proofline", detail: "GitHub Actions" },
    { label: "Validate", detail: "org · billing · permission" },
    { label: "Pin commit", detail: "3f9c2ad" },
    { label: "Run approved snapshot", detail: "142 tests · Playwright" },
    { label: "Report status", detail: "back to the pipeline" }
  ],
  providers: ["GitHub Actions", "GitLab CI", "Bitbucket Pipelines"],
  branches: ["development", "qa", "production", "feature/checkout-v2"],
  history: [
    { test: "Login validation", results: ["pass", "pass", "pass", "pass"] },
    { test: "Add to cart", results: ["pass", "fail", "pass", "pass"] },
    { test: "Payment validation", results: ["pass", "pass", "pass", "fail"] },
    { test: "Product search and filters", results: ["pass", "env", "pass", "none"] }
  ] satisfies { test: string; results: BranchResult[] }[],
  legend: [
    { result: "pass", label: "Passed" },
    { result: "fail", label: "Test failed" },
    { result: "env", label: "Environment failure" },
    { result: "none", label: "Not run on branch" }
  ] satisfies { result: BranchResult; label: string }[],
  rules: [
    "The commit SHA is authoritative; a branch name never silently resolves to your default branch.",
    "Pending, rejected or unapproved tests never run, whoever triggers the pipeline.",
    "Retries are stored as separate attempts. Test failures are told apart from environment failures."
  ]
} as const;
