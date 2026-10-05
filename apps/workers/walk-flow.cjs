const { chromium } = require("playwright");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await context.addInitScript(`
    (() => {
      window.__prooflineSteps = [];
      document.addEventListener("click", (e) => {
        const text = (e.target.textContent || "").trim().slice(0, 40);
        window.__prooflineSteps.push("click " + (text || "canvas-area"));
      }, true);
    })();
  `);
  await page.goto("https://qa01-rs-customizer.web.app/?projectId=193&modelCode=PTS8013CU", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(12000);
  const steps = [];

  // Text-node based finder: matches text even when the element has other children
  const clickText = async (pattern) => {
    const pos = await page.evaluate((pat) => {
      const re = new RegExp(pat, "i");
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent.trim();
        if (!re.test(text) || text.length > 60) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        const r = range.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: text.slice(0, 30) };
      }
      return null;
    }, pattern);
    if (!pos) { console.log("  NOT FOUND:", pattern); return false; }
    await page.mouse.click(pos.x, pos.y);
    steps.push("click " + pos.text);
    await sleep(1800);
    return true;
  };

  for (let i = 0; i < 4; i++) {
    const ok = await clickText("^next$");
    if (!ok) { console.log("  Next NOT FOUND"); break; }
  }
  await clickText("hypr twill");
  await sleep(500);
  await clickText("right sleeve");
  await sleep(500);
  await clickText("^custom$");
  await sleep(5000);
  const state = await page.evaluate(() => ({
    inputs: Array.from(document.querySelectorAll("input")).filter((el) => el.getBoundingClientRect().width > 0).map((el) => ({ type: el.getAttribute("type") || "(none)", cls: (el.className || "").toString().slice(0, 30) })),
    loginModal: /user id/i.test(document.body.innerText),
    myArt: /my art/i.test(document.body.innerText),
    apply: /apply/i.test(document.body.innerText)
  }));
  console.log("post-CUSTOM state:", JSON.stringify(state, null, 1));
  await page.screenshot({ path: "C:/Users/MuhammadNafees/OneDrive - Royal Cyber Inc/Documents/test/app/artifacts/tree-walk-flow.png" });
  console.log("captured steps:", JSON.stringify(steps, null, 1));
  await browser.close();
})();
