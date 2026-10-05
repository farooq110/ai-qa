const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleMessages = [];
  const networkCalls = [];
  page.on("console", (msg) => consoleMessages.push({ type: msg.type(), text: (msg.text() || "").slice(0, 200) }));
  page.on("response", (res) => {
    const url = res.url();
    if (res.status() >= 400 || /auth|login|user|session|token/i.test(url)) {
      networkCalls.push({ status: res.status(), url: url.slice(0, 120) });
    }
  });

  await page.goto("https://qa01-rs-customizer.web.app/?projectId=193&modelCode=PTS8013CU", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);
  for (let i = 0; i < 4; i++) {
    await page.getByRole("button", { name: "Next" }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  // click the CUSTOM design type
  await page.getByText("CUSTOM", { exact: true }).first().click({ timeout: 8000 }).catch((e) => console.log("CUSTOM click:", e.message.split("\n")[0]));
  await page.waitForTimeout(3000);

  // monitor for 12 seconds, snapshot every 2 seconds
  const timeline = [];
  for (let t = 0; t <= 12; t += 2) {
    const snap = await page.evaluate(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const inputs = Array.from(document.querySelectorAll("input, textarea")).map((el) => ({ type: el.getAttribute("type") || "(none)", placeholder: el.placeholder || "", visible: el.getBoundingClientRect().width > 0 }));
      const dialogs = Array.from(document.querySelectorAll("[role=dialog], .modal, [class*=modal], [class*=Modal], [class*=overlay], [class*=popup]")).filter(visible).map((el) => ({ tag: el.tagName, cls: (el.className || "").toString().slice(0, 60), text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) }));
      const userIdText = Array.from(document.querySelectorAll("*")).filter((el) => el.children.length === 0 && /USER ID|PASSWORD/i.test(el.textContent || "")).map((el) => ({ tag: el.tagName, text: (el.textContent || "").trim().slice(0, 40), visible: el.getBoundingClientRect().width > 0 }));
      return { visibleInputs: inputs.filter((i) => i.visible).length, hiddenInputs: inputs.length - inputs.filter((i) => i.visible).length, dialogs, userIdText, hasLoginButton: !!Array.from(document.querySelectorAll("button")).find((b) => /login/i.test(b.textContent || "")) };
    });
    timeline.push({ at: t + "s", ...snap });
    if (t < 12) await page.waitForTimeout(2000);
  }

  console.log("=== TIMELINE ===");
  console.log(JSON.stringify(timeline, null, 1));
  console.log("=== CONSOLE MESSAGES (errors/warnings) ===");
  console.log(JSON.stringify(consoleMessages.filter((m) => m.type === "error" || m.type === "warning").slice(0, 10), null, 1));
  console.log("=== NETWORK 4xx/5xx + auth-related ===");
  console.log(JSON.stringify(networkCalls.slice(0, 15), null, 1));
  await page.screenshot({ path: "C:/Users/MuhammadNafees/OneDrive - Royal Cyber Inc/Documents/test/app/artifacts/debug-final-state.png" });
  await browser.close();
})().catch((e) => { console.error("PROBE FAILED:", e.message); process.exit(1); });
