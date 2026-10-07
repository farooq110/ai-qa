// Demonstration data for the hero review mkt-panel. Synthetic: labeled as such in the UI.

export const hero = {
  headline: ["AI drafts the tests.", "You approve what runs."],
  subhead: "Evidence-backed Playwright tests drafted from your repository. Nothing runs until your team approves it.",
  primaryCta: "Create your organization",
  secondaryCta: "How review works",
  facts: [
    { label: "Repositories", value: "GitHub · Bitbucket" },
    { label: "CI", value: "GitHub Actions · GitLab CI · Bitbucket Pipelines" },
    { label: "AI tokens per CI run", value: "0" }
  ]
} as const;

export type ReviewLine = {
  readonly code: string;
  readonly tone?: "key" | "string" | "plain";
};

export const reviewDemo = {
  repo: "acme/storefront",
  branch: "main",
  commit: "3f9c2ad",
  title: "Cart and Checkout › Payment validation",
  candidates: 12,
  analysis: [
    { label: "Routes", value: "38" },
    { label: "Forms", value: "61" },
    { label: "API calls", value: "47" }
  ],
  file: "checkout/payment-validation/rejects-expired-card.yaml",
  lines: [
    { code: "name: Rejects an expired card at checkout", tone: "key" },
    { code: "category: negative · priority: high", tone: "plain" },
    { code: "steps:", tone: "key" },
    { code: "  - goto: /checkout", tone: "string" },
    { code: '  - fill: { label: "Card number", value: "4000 0000 0000 0069" }', tone: "string" },
    { code: '  - fill: { label: "Expiry", value: "01/20" }', tone: "string" },
    { code: '  - click: { role: button, name: "Pay now" }', tone: "string" },
    { code: '  - expect: { text: "Your card has expired" }', tone: "string" }
  ] satisfies ReviewLine[],
  evidence: ["src/routes/checkout.tsx:88", "src/components/PaymentForm.tsx:142", "POST /api/payments"],
  confidence: "0.92",
  reviewer: "M. Ortiz",
  checks: [
    { name: "chromium · shard 1/3", duration: "38s" },
    { name: "chromium · shard 2/3", duration: "41s" },
    { name: "chromium · shard 3/3", duration: "36s" }
  ]
} as const;
