import io

# ---------- 1. Worker: wait for app render after navigate, retry chain on empty ----------
p = r"C:\Users\MuhammadNafees\OneDrive - Royal Cyber Inc\Documents\test\app\apps\workers\src\worker.ts"
t = io.open(p, encoding="utf-8").read()

# render-wait helper
anchor = "async function executeStep(page: Page, step: TestStep, baseUrl: string, credentials?: EnvCredentials | null) {"
addition = """/** Heavy SPAs take 10-15s to render; poll until interactive elements appear. */
async function waitForAppRender(page: Page, timeoutMs = 20000, minVisible = 3): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => {
      let visible = 0;
      for (const el of document.querySelectorAll("button, a, [role=button], input")) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) visible++;
      }
      return visible;
    }).catch(() => 0);
    if (count >= minVisible) return;
    await page.waitForTimeout(1500).catch(() => undefined);
  }
}

async function executeStep(page: Page, step: TestStep, baseUrl: string, credentials?: EnvCredentials | null) {"""
assert anchor in t, "executeStep anchor missing"
t = t.replace(anchor, addition, 1)

# navigate: replace fixed settle with render poll
old_nav = """    const result = await page.goto(target, { waitUntil: "domcontentloaded", timeout: stepTimeoutMs * 2 });
    // Heavy client-rendered apps need settle time before the first interaction.
    await page.waitForTimeout(2500).catch(() => undefined);
    return result;"""
new_nav = """    const result = await page.goto(target, { waitUntil: "domcontentloaded", timeout: stepTimeoutMs * 2 });
    // Heavy client-rendered apps (canvas bundles, fonts) render over ~10s —
    // poll until interactive elements appear instead of a fixed settle.
    await waitForAppRender(page, 20000, 2).catch(() => undefined);
    return result;"""
assert old_nav in t, "nav settle anchor missing"
t = t.replace(old_nav, new_nav, 1)

# click chain: if page had no visible elements, re-wait and retry the whole chain once
old_chain_start = """    const stageTimeout = Math.max(3000, Math.floor(stepTimeoutMs / 2));"""
new_chain_start = """    const runChain = async () => {
      const stageTimeout = Math.max(3000, Math.floor(stepTimeoutMs / 2));"""
old_chain_end = """      () => page.getByText(new RegExp(trimmed.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"), "i")).first().click({ timeout: stageTimeout })]"
    ];"""
new_chain_end = """      () => page.getByText(new RegExp(trimmed.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"), "i")).first().click({ timeout: stageTimeout })]"
    ];
    let chainLastError: unknown;
    for (const stage of stages) {
      try { return await stage(); } catch (error) { chainLastError = error; }
    }
    throw chainLastError;
    };"""
old_full = old_chain_start + """
    const stages = ["""
# simpler: wrap stages array + loop into a callable chain with one retry
t = t.replace(old_chain_start, new_chain_start, 1)
t = t.replace(old_chain_end, new_chain_end, 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(t)
print("worker render-wait + retry wired")
