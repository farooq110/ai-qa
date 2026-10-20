// Synthetic diff summary for the regeneration demonstration.

export type RegenerationMode = "incremental" | "full";

export const regeneration = {
  heading: "Regenerate without losing a reviewed test.",
  intro:
    "When the code moves, ProoflineQA compares commits and only revisits what changed. Manual, approved, edited and historical tests are always preserved.",
  modes: {
    incremental: {
      label: "Incremental regeneration",
      badge: "Recommended",
      hint: "Analyzes only changed and affected capabilities between the last analyzed commit and the target.",
      result: [
        { label: "New candidates", value: "14", tone: "ai" },
        { label: "Marked Needs review", value: "3", tone: "pending" },
        { label: "Approved tests touched", value: "0", tone: "approve" }
      ]
    },
    full: {
      label: "Full regeneration",
      badge: "Uses more quota",
      hint: "Reanalyzes the complete revision and proposes fresh candidates for side-by-side comparison. Asks for confirmation first.",
      result: [
        { label: "New candidates", value: "126", tone: "ai" },
        { label: "Duplicates linked", value: "88", tone: "pending" },
        { label: "Approved tests touched", value: "0", tone: "approve" }
      ]
    }
  },
  base: "a41e07c",
  target: "3f9c2ad",
  changed: [
    { path: "src/components/PaymentForm.tsx", add: 18, del: 4 },
    { path: "src/routes/checkout.tsx", add: 6, del: 2 },
    { path: "src/features/cart/useCart.ts", add: 3, del: 3 }
  ],
  affected: ["Cart and Checkout › Payment validation", "Cart and Checkout › Update quantity"]
} as const;
