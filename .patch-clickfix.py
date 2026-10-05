import io

# ---------- 1. Worker: forgiving click chain + page-context errors ----------
p = r"C:\Users\MuhammadNafees\OneDrive - Royal Cyber Inc\Documents\test\app\apps\workers\src\worker.ts"
t = io.open(p, encoding="utf-8").read()

old = """  if (step.action === "click") {
    const button = page.getByRole("button", { name: step.target, exact: true });
    if (await button.count()) return button.first().click(timeout);
    const link = page.getByRole("link", { name: step.target, exact: true });
    if (await link.count()) return link.first().click(timeout);
    return page.getByText(step.target, { exact: true }).first().click(timeout);
  }"""
new = """  if (step.action === "click") {
    // Resolution chain: exact role matches, exact text, then a forgiving
    // case-insensitive partial-text match ("DECORATION" hits "5 DECORATION").
    const button = page.getByRole("button", { name: step.target, exact: true });
    if (await button.count()) return button.first().click(timeout);
    const link = page.getByRole("link", { name: step.target, exact: true });
    if (await link.count()) return link.first().click(timeout);
    const text = page.getByText(step.target, { exact: true });
    if (await text.count()) return text.first().click(timeout);
    const escaped = step.target.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
    const partial = page.getByText(new RegExp(escaped, "i"));
    if (await partial.count()) return partial.first().click(timeout);
    // Nothing matched: fail with what IS on the page so the run is self-diagnosing.
    const visible = await page.evaluate(() => {
      const clean = (value: string) => value.replace(/\\s+/g, " ").trim();
      const found: string[] = [];
      for (const el of Array.from(document.querySelectorAll("button, a, [role=button]"))) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const label = clean(el.textContent || "");
        if (label && label.length <= 40 && !found.includes(label)) found.push(label);
      }
      return found.slice(0, 12);
    }).catch(() => [] as string[]);
    throw new Error(`No element matching "${step.target}". Visible buttons/links on the page: ${visible.length ? visible.join(" | ") : "(none)"}`);
  }"""
assert old in t, "click anchor missing"
t = t.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(t)
print("worker click chain upgraded")

# ---------- 2. Generator: instruction-phrase sanitizer ----------
p = r"C:\Users\MuhammadNafees\OneDrive - Royal Cyber Inc\Documents\test\app\apps\api\src\generations\generations.service.ts"
t = io.open(p, encoding="utf-8").read()

old = """      steps: (Array.isArray(raw.steps) ? raw.steps : [])
        .map((step) => ({
          action: String(step?.action ?? "").toLowerCase().trim(),
          target: String(step?.target ?? "").trim(),"""
new = """      steps: (Array.isArray(raw.steps) ? raw.steps : [])
        .map((step) => ({
          action: String(step?.action ?? "").toLowerCase().trim(),
          target: this.normalizeStepTarget(String(step?.target ?? "").trim()),"""
assert old in t, "steps anchor missing"
t = t.replace(old, new, 1)

anchor = "  private normalizeCategory(value: unknown)"
addition = """  /**
   * The model sometimes writes instructions into targets ("click on DECORATION
   * Stepper"). Reduce them to the bare element name; URLs pass through as-is.
   */
  private normalizeStepTarget(target: string): string {
    if (!target || /^[/?#]/.test(target) || /^https?:\\/\\//i.test(target)) return target;
    let cleaned = target;
    const prefix = cleaned.match(/^(?:cl+ick|tap|press|select|choose|go to|navigate to|open)\\s+(?:on\\s+|the\\s+)?(.+)$/i);
    if (prefix) cleaned = prefix[1];
    cleaned = cleaned.replace(/\\s+(?:stepper|button|link|tab|menu|option|from\\s+sidebar)$/i, "");
    return cleaned.trim();
  }

  private normalizeCategory(value: unknown)"""
assert anchor in t
t = t.replace(anchor, addition, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(t)
print("generator sanitizer added")
