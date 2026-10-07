export type Plan = {
  readonly id: "starter" | "team" | "business" | "enterprise";
  readonly name: string;
  readonly slots: string;
  readonly summary: string;
  readonly cta: string;
  readonly featured?: boolean;
};

export const pricing = {
  heading: "Pay for concurrency, not idle servers.",
  intro:
    "Every plan includes the full review workflow. Plans differ by how many approved tests can run at once. Billing is monthly, quarterly or yearly.",
  plans: [
    { id: "starter", name: "Starter", slots: "5", summary: "One team proving out reviewed AI coverage.", cta: "Start with Starter" },
    { id: "team", name: "Team", slots: "25", summary: "Product teams running suites on every push.", cta: "Start with Team", featured: true },
    { id: "business", name: "Business", slots: "100", summary: "Large suites across many projects and branches.", cta: "Start with Business" },
    { id: "enterprise", name: "Enterprise", slots: "Custom", summary: "Configurable capacity, limits and retention.", cta: "Set up Enterprise" }
  ] satisfies Plan[],
  included: [
    "Human approval gate on every test version",
    "GitHub and Bitbucket repositories",
    "GitHub Actions, GitLab CI and Bitbucket Pipelines",
    "Branch- and commit-aware result history",
    "Logs, screenshots, videos and traces",
    "Admin, QA and Developer roles",
    "AI generation quota pooled across projects"
  ]
} as const;
