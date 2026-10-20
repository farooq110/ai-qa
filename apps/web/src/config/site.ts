const trimSlash = (url: string) => url.replace(/\/+$/, "");

const siteUrl = trimSlash(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3004");
const appUrl = trimSlash(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3004");

export const site = {
  name: "ProoflineQA",
  title: "ProoflineQA — AI-generated tests, human-approved, Playwright-run",
  tagline: "AI writes the tests. Your team approves them. Only approved tests run.",
  description:
    "ProoflineQA connects your repository, maps your application by business capability, drafts evidence-backed Playwright tests with AI, and runs only the tests a human has approved — from the dashboard or CI, pinned to the exact commit.",
  url: siteUrl,
  locale: "en_US",
  links: {
    signup: "/signup",
    signin: "/signin"
  }
} as const;

export const nav = [
  { label: "Review", href: "#review" },
  { label: "Evidence", href: "#evidence" },
  { label: "Checks", href: "#checks" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" }
] as const;

/** Every anchored section in reading order; drives the gutter and the active tab. */
export const sections = [
  { id: "top", label: "Overview" },
  { id: "review", label: "Review gate" },
  { id: "evidence", label: "Evidence" },
  { id: "capabilities", label: "Capabilities" },
  { id: "regenerate", label: "Regeneration" },
  { id: "checks", label: "CI checks" },
  { id: "scale", label: "Scale" },
  { id: "pricing", label: "Pricing" },
  { id: "faq", label: "FAQ" }
] as const;

export const sectionIds: readonly string[] = sections.map((s) => s.id);
