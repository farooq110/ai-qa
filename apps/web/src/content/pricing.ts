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
    "Every plan includes the full review workflow. Plans differ by how many approved tests can run at once, how much AI generation you get, and how many projects you connect. Start with a free 7-day trial — no credit card required.",
  plans: [
    { id: "starter", name: "Starter", slots: "5", summary: "2M AI tokens/mo · 5 projects · 180-day evidence retention. One team proving out reviewed AI coverage.", cta: "Start with Starter" },
    { id: "team", name: "Teams", slots: "25", summary: "8M AI tokens/mo · 10 projects · 1-year evidence retention. Product teams running suites on every push.", cta: "Start with Teams", featured: true },
    { id: "business", name: "Business", slots: "60", summary: "25M AI tokens/mo · 50 projects · 2-year evidence retention. Large suites across many projects and branches.", cta: "Start with Business" },
    { id: "enterprise", name: "Enterprise", slots: "Custom", summary: "Configurable capacity, limits and retention. Custom contract with our team.", cta: "Set up Enterprise" }
  ] satisfies Plan[],
  included: [
    "7-day free trial on every plan — no credit card required",
    "Human approval gate on every test version",
    "GitHub, Bitbucket and GitLab repositories",
    "GitHub Actions, GitLab CI and Bitbucket Pipelines",
    "Branch- and commit-aware result history",
    "Screenshots and evidence stored in your private artifact store",
    "Admin, QA and Developer roles",
    "AI generation quota pooled across projects"
  ]
} as const;
