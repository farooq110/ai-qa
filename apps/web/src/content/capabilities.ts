// Synthetic suite used to contrast capability-first and folder-first organization.

export type SuiteTest = {
  readonly id: string;
  readonly name: string;
  readonly capability: string;
  readonly folder: string;
  readonly tags: readonly string[];
};

export const capabilities = {
  heading: "Organized by what your product does.",
  intro:
    "ProoflineQA groups tests by the business capability they protect, not the folder the code happens to live in. Your team layers its own modules and tags on top, and regeneration never overwrites them.",
  views: { capability: "By capability", folder: "By folder" },
  tests: [
    { id: "t1", name: "Login validation", capability: "Authentication", folder: "src/routes/auth", tags: ["smoke"] },
    { id: "t2", name: "Password reset", capability: "Authentication", folder: "src/features/account", tags: [] },
    { id: "t3", name: "Browse products", capability: "Product Management", folder: "src/routes/catalog", tags: ["smoke"] },
    { id: "t4", name: "Product search and filters", capability: "Product Management", folder: "src/components/search", tags: ["regression"] },
    { id: "t5", name: "Product details", capability: "Product Management", folder: "src/routes/catalog", tags: [] },
    { id: "t6", name: "Add to cart", capability: "Cart and Checkout", folder: "src/features/cart", tags: ["critical"] },
    { id: "t7", name: "Update quantity", capability: "Cart and Checkout", folder: "src/features/cart", tags: [] },
    { id: "t8", name: "Payment validation", capability: "Cart and Checkout", folder: "src/components/forms", tags: ["critical", "release-1"] }
  ] satisfies SuiteTest[],
  notes: [
    "Tests can belong to several modules and carry several tags.",
    "Archiving a module never deletes its tests, versions, approvals or history.",
    "Filter by module, tag, capability, route, status, category, priority, branch or last result."
  ]
} as const;
