import io

# 1. test-dsl: add screenshot action
p = r"C:\Users\MuhammadNafees\OneDrive - Royal Cyber Inc\Documents\test\app\packages\test-dsl\src\index.ts"
t = io.open(p, encoding="utf-8").read()
old = 'export type TestAction = "navigate" | "click" | "fill" | "select" | "upload" | "assert" | "waitFor";'
new = 'export type TestAction = "navigate" | "click" | "fill" | "select" | "upload" | "assert" | "waitFor" | "screenshot";'
assert old in t, "dsl anchor"
t = t.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(t)
print("test-dsl ok")

# 2. recorder script: label-aware describe (fallback to css path already present)
p = r"C:\Users\MuhammadNafees\OneDrive - Royal Cyber Inc\Documents\test\app\apps\api\src\recordings\recordings.service.ts"
t = io.open(p, encoding="utf-8").read()
old = """      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        return clean(el.placeholder || el.name || el.id || el.getAttribute("type") || "field");
      }
      if (el.tagName === "SELECT") {
        return clean(el.getAttribute("aria-label") || el.name || el.id || "dropdown");
      }"""
new = """      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const lbl = el.labels && el.labels[0] ? clean(el.labels[0].textContent) : "";
        return lbl || clean(el.placeholder || el.name || el.id || el.getAttribute("type") || "field");
      }
      if (el.tagName === "SELECT") {
        const lbl = el.labels && el.labels[0] ? clean(el.labels[0].textContent) : "";
        return lbl || clean(el.getAttribute("aria-label") || el.name || el.id || "dropdown");
      }"""
assert old in t, "recorder describe anchor missing"
t = t.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(t)
print("recorder script ok")

# 3. worker: screenshot action branch in runTestCase
p = r"C:\Users\MuhammadNafees\OneDrive - Royal Cyber Inc\Documents\test\app\apps\workers\src\worker.ts"
t = io.open(p, encoding="utf-8").read()
old = """  try {
    for (const [index, step] of definition.steps.entries()) {
      const startedAt = Date.now();
      try {
        await executeStep(page, step, baseUrl, credentials);"""
new = """  try {
    for (const [index, step] of definition.steps.entries()) {
      const startedAt = Date.now();
      if (step.action === "screenshot") {
        // Visual-check step: capture the current state (e.g. canvas flip) and
        // attach it to the run for human review - always passes.
        const shotDir = join(artifactDir, planId);
        mkdirSync(shotDir, { recursive: true });
        const shotPath = join(planId, testCaseId + "-review-" + (index + 1) + ".png");
        await page.screenshot({ path: join(artifactDir, shotPath), fullPage: true }).catch(() => undefined);
        await prisma.artifact.create({ data: { executionPlanId: planId, testCaseId: item.testCaseId, kind: "SCREENSHOT", path: shotPath.split(/[\\\\/]/).join("/"), contentType: "image/png" } }).catch(() => undefined);
        steps.push({ index, action: "screenshot", target: step.target, status: "PASSED", durationMs: Date.now() - startedAt });
        continue;
      }
      try {
        await executeStep(page, step, baseUrl, credentials);"""
assert old in t, "worker screenshot anchor missing"
t = t.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(t)
print("worker screenshot ok")
