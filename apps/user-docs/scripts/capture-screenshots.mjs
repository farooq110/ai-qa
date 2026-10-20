/**
 * Captures 2x (retina) screenshots of the ProoflineQA test editor for the docs.
 * Produces the same states as the previous 1x session, saved to /tmp/shots2x/.
 *
 * Prereqs: API on :4000, web on :3004, a signed-in demo account, one project.
 * Run:  cd apps/workers && node ../../apps/user-docs/scripts/capture-screenshots.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

const require2 = createRequire("/home/hyperdev-solutions/Desktop/projects/desktop/agentic-qa/apps/workers/package.json");
const { chromium } = require2("playwright");

const TOKEN = readFileSync("/tmp/demo-token.txt", "utf8").trim();
const OUT = "/tmp/shots2x";
mkdirSync(OUT, { recursive: true });

const rects = {};
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
await context.addInitScript({
  content: `window.localStorage.setItem('proofline.accessToken', ${JSON.stringify(TOKEN)});`,
});
const page = await context.newPage();
await page.goto("http://localhost:3004/test-cases", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);

const box = (sel) => {
  const el = typeof sel === "string" ? page.locator(sel) : sel;
  return el.first().boundingBox();
};
const injectHighlight = async () => {
  await page.evaluate(`(() => {
    if (!document.getElementById('doc-hl')) {
      const s = document.createElement('style'); s.id = 'doc-hl';
      s.textContent = '.doc-hl{outline:3px solid #f59e0b !important; outline-offset:2px !important; border-radius:6px !important; position:relative; z-index:60;}';
      document.head.appendChild(s);
    }
  })()`);
};

// 01 — library header with the New manual test button highlighted
await page.waitForSelector('button:has-text("New manual test")', { timeout: 20000 });
await injectHighlight();
await page.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'New manual test');
  b.classList.add('doc-hl');
})()`);
rects["new-manual-test"] = await box('button:has-text("New manual test")');
await page.screenshot({ path: `${OUT}/shots-01-header.png` });
await page.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'New manual test');
  b.classList.remove('doc-hl');
})()`);

// 02 — full editor (tall viewport), empty state
await page.getByRole("button", { name: "New manual test" }).click();
await page.waitForTimeout(600);
await page.setViewportSize({ width: 1400, height: 2000 });
await page.waitForTimeout(400);
rects["editorModal"] = await box(".modal.wide");
await page.screenshot({ path: `${OUT}/shots-02-editor-full.png` });

// fill example fields
await page.getByRole("textbox", { name: "Title" }).fill("Add to cart updates the badge");
await page.getByRole("textbox", { name: "Capability" }).fill("Cart and checkout");
await page.getByRole("textbox", { name: "Route / page" }).fill("/products");
await page.getByRole("textbox", { name: "Expected result" }).fill("The cart badge shows the updated quantity.");

// step 1
await page.getByRole("textbox", { name: "Step 1 target" }).fill("/products");
// step 2
await page.getByRole("button", { name: "Add step" }).click();
await page.waitForTimeout(200);
await page.getByRole("textbox", { name: "Step 2 target" }).fill("Add to cart");
// 04 — open action dropdown on step 2
await page.locator(".step-row").nth(1).locator(".combo.step-action .combo-trigger").click();
await page.waitForTimeout(300);
rects["action-dropdown"] = { menu: await box(".combo-menu") };
await page.screenshot({ path: `${OUT}/shots-04-action-dropdown.png` });
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// 09 — hover slot 2 to reveal the Insert pill
await page.locator(".step-slot").nth(1).hover({ position: { x: 400, y: 15 } });
await page.waitForTimeout(400);
rects["insertAdd"] = {
  pill: await box(".step-slot:nth-of-type(2) .step-insert, .step-slot .step-insert"),
  add: await box('button:has-text("Add step")'),
  fieldset: await box("fieldset.steps-editor"),
};
await page.screenshot({ path: `${OUT}/shots-09-insert-add.png` });

// step 3: assert
await page.getByRole("button", { name: "Add step" }).click();
await page.waitForTimeout(200);
await page.locator(".step-row").nth(2).locator(".combo.step-action .combo-trigger").click();
await page.waitForTimeout(250);
await page.locator(".combo-menu .combo-option").filter({ hasText: /^assert$/ }).click();
await page.waitForTimeout(250);
await page.getByRole("textbox", { name: "Step 3 target" }).fill("1");
// 05 — open the condition select
await page.locator(".step-row").nth(2).locator(".combo.step-condition .combo-trigger").click();
await page.waitForTimeout(300);
rects["condMenu"] = { condMenu: await box(".combo-menu") };
await page.screenshot({ path: `${OUT}/shots-05-condition-select.png` });
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// clear focus, then 13 — clean worked example + measurements
await page.mouse.click(700, 200);
await page.waitForTimeout(300);
rects["fieldset"] = await box("fieldset.steps-editor");
rects["recordBar"] = await box(".record-bar");
rects["varsHint"] = await box(".vars-hint");
rects["footer"] = await box(".modal.wide footer");
rects["rows"] = await page.locator(".step-row").evaluateAll((els) =>
  els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
);
rects["row2"] = rects["rows"][1];
rects["row2Children"] = await page.locator(".step-row").nth(1).evaluate((row) => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const ghosts = row.querySelectorAll("button.mini-button.ghost");
  return {
    drag: box(row.querySelector(".drag-handle")),
    index: box(row.querySelector(".step-index")),
    action: box(row.querySelector(".combo.step-action")),
    target: box(row.querySelector('input[aria-label="Step 2 target"]')),
    up: box(ghosts[0]),
    down: box(ghosts[1]),
    remove: box(row.querySelector("button.mini-button.danger")),
  };
});
await page.screenshot({ path: `${OUT}/shots-13-worked-example.png` });

// step 4: assert color — region fields + Pick
await page.getByRole("button", { name: "Add step" }).click();
await page.waitForTimeout(200);
await page.locator(".step-row").nth(3).locator(".combo.step-action .combo-trigger").click();
await page.waitForTimeout(250);
await page.locator(".combo-menu .combo-option").filter({ hasText: /^assert color$/ }).click();
await page.waitForTimeout(250);
await page.locator('.step-row').nth(3).locator('input[aria-label="Step 4 value"]').fill("#0d5ea0");
rects["row4"] = await box(".step-row >> nth=3");
await page.screenshot({ path: `${OUT}/shots-06-region-fields.png` });

// 07 — region picker modal
await page.getByRole("button", { name: "Pick" }).click();
await page.waitForTimeout(500);
rects["pickerModal"] = await box(".modal.region-picker");
await page.screenshot({ path: `${OUT}/shots-07-region-picker.png` });
await page.locator(".modal.region-picker .icon-button").click();
await page.waitForTimeout(200);
await page.getByRole("button", { name: "Remove step 4" }).click();
await page.waitForTimeout(200);

// 10 — drag-over highlight on step 2
await page.locator(".step-row").nth(1).evaluate((el) => el.classList.add("drag-over"));
await page.waitForTimeout(150);
await page.screenshot({ path: `${OUT}/shots-10-drag-over.png` });
await page.locator(".step-row").nth(1).evaluate((el) => el.classList.remove("drag-over"));

writeFileSync("/tmp/shots2x-rects.json", JSON.stringify({ scale: 2, rects }, null, 1));
console.log("captured", Object.keys(rects).length, "rect groups at 2x");
await browser.close();
