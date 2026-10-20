/**
 * Records the "Writing test steps" tutorial video against the real ProoflineQA
 * web app using Playwright's built-in video capture.
 *
 * Prereqs: API on :4000, web on :3004, a signed-in demo account, one project.
 * Run:  cd apps/workers && node ../../apps/user-docs/scripts/record-tutorial.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

// playwright is a dependency of apps/workers — resolve it from there
const require2 = createRequire("/home/hyperdev-solutions/Desktop/projects/desktop/agentic-qa/apps/workers/package.json");
const { chromium } = require2("playwright");

const TOKEN = readFileSync("/tmp/demo-token.txt", "utf8").trim();
const OUT_DIR = "/tmp/tutorial-video";
mkdirSync(OUT_DIR, { recursive: true });

const marks = [];
let t0 = 0;
const mark = (label) => marks.push({ label, t: (Date.now() - t0) / 1000 });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 900 } },
});
await context.addInitScript({
  content: `window.localStorage.setItem('proofline.accessToken', ${JSON.stringify(TOKEN)});`,
});
const page = await context.newPage();
await page.goto("http://localhost:3004/test-cases", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);

t0 = Date.now();
await pause(1800); mark("start");
await page.getByRole("button", { name: "New manual test" }).click();
mark("open-editor"); await pause(2600);
await page.getByRole("textbox", { name: "Title" }).fill("Add to cart updates the badge");
mark("title"); await pause(1800);
await page.getByRole("textbox", { name: "Capability" }).fill("Cart and checkout");
await page.getByRole("textbox", { name: "Route / page" }).fill("/products");
mark("meta"); await pause(2000);
await page.getByRole("textbox", { name: "Step 1 target" }).fill("/products");
mark("step1"); await pause(2400);
await page.getByRole("button", { name: "Add step" }).click();
await pause(1000);
await page.locator(".step-row").nth(1).locator(".combo.step-action .combo-trigger").click();
mark("dropdown-open"); await pause(1600);
await page.locator(".combo-menu .combo-option").filter({ hasText: /^click$/ }).click();
await pause(900);
await page.getByRole("textbox", { name: "Step 2 target" }).fill("Add to cart");
mark("step2"); await pause(2400);
await page.getByRole("button", { name: "Add step" }).click();
await pause(900);
await page.locator(".step-row").nth(2).locator(".combo.step-action .combo-trigger").click();
await pause(900);
await page.locator(".combo-menu .combo-option").filter({ hasText: /^assert$/ }).click();
await pause(1000);
await page.getByRole("textbox", { name: "Step 3 target" }).fill("1");
mark("step3"); await pause(2000);
await page.locator(".step-row").nth(2).locator(".combo.step-condition .combo-trigger").click();
mark("conditions"); await pause(2200);
await page.keyboard.press("Escape"); await pause(600);
await page.getByRole("button", { name: "Move step 3 up" }).click();
mark("reorder"); await pause(1800);
await page.getByRole("button", { name: "Move step 2 down" }).click();
await pause(1600);
await page.getByRole("textbox", { name: "Expected result" }).fill("The cart badge shows the updated quantity.");
mark("expected"); await pause(2200);
await page.getByRole("button", { name: "Create test case" }).click();
mark("save"); await pause(3500);

const video = page.video();
await context.close(); // flushes the video file
const videoPath = await video.path();
writeFileSync("/tmp/tutorial-video/marks.json", JSON.stringify(marks, null, 1));
console.log("video:", videoPath);
console.log("marks:", JSON.stringify(marks));
await browser.close();
