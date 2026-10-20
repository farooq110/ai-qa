import { DelayedError, Worker, Queue, type Job } from "bullmq";
import IORedis from "ioredis";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { chromium, type Page } from "playwright";
import sharp from "sharp";
import { evaluateResponseRule, installHostLimiter, isAuthRoute, matchesApiCall, needsAnonymousSession, onLoginScreen, parseResponseRule, sessionKeeper, type LoginCredentials, type SessionKeeper, type TestDefinition, type TestStep } from "@ai-qa/test-dsl";
import { loadCredentials, loadFixtureVars, loadSessionState, sessionStore } from "./environment";
import { assertNotVisible, firstPage, runRecovering } from "./step-helpers";
export { firstPage, runRecovering } from "./step-helpers";
import { attachBypassHeaders, loadBypassHeaders } from "./bypass-headers.js";
import { processVerification } from "./verify.js";

// lazyConnect: importing this module (e.g. from an eval script) must not open a socket by itself -
// only actually using the queue (ciReports.add, or main()'s Worker) should connect.
const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6380", { maxRetriesPerRequest: null, lazyConnect: true });
const prisma = new PrismaClient();
// The API consumes this queue and mirrors CI plans' state onto the commit (GitHub check / commit status).
const ciReports = new Queue("ci-reports", { connection });
const reportCi = (plan: { id: string; trigger: string }) => plan.trigger === "CI"
  ? ciReports.add("report", { planId: plan.id }, { attempts: 3, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 500, removeOnFail: 500 }).then(() => undefined)
  : Promise.resolve();
/** How long a plan waits before re-checking for a free slot when its organization is at its limit. */
const SLOT_RETRY_MS = 15_000;
const artifactDir = process.env.ARTIFACT_DIR ?? join(process.cwd(), "artifacts");
// Artifacts persist to S3 when AWS credentials are configured, otherwise local disk.
const s3Client = process.env.AWS_S3_BUCKET_NAME && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
  ? new S3Client({ region: process.env.AWS_S3_REGION ?? "us-east-1" })
  : null;

async function createArtifact(planId: string, testCaseId: string, kind: "SCREENSHOT" | "LOG", fileName: string, body: Buffer, contentType: string): Promise<void> {
  if (s3Client) {
    const key = `artifacts/${planId}/${fileName}`;
    try {
      await s3Client.send(new PutObjectCommand({ Bucket: process.env.AWS_S3_BUCKET_NAME, Key: key, Body: body, ContentType: contentType }));
      await prisma.artifact.create({ data: { executionPlanId: planId, testCaseId, kind, path: key, contentType, storage: "s3" } });
      return;
    } catch (error) {
      // S3 outages must never stall a plan — fall back to local disk.
      console.warn(JSON.stringify({ service: "ai-qa-workers", artifact: "s3 upload failed, storing locally", error: error instanceof Error ? error.message.slice(0, 120) : String(error) }));
    }
  }
  const rel = join(planId, fileName);
  mkdirSync(join(artifactDir, planId), { recursive: true });
  writeFileSync(join(artifactDir, rel), body);
  await prisma.artifact.create({ data: { executionPlanId: planId, testCaseId, kind, path: rel, contentType, storage: "local" } });
}
const concurrency = Math.max(1, Number(process.env.PLAYWRIGHT_WORKER_CONCURRENCY ?? 2));
const stepTimeoutMs = Number(process.env.PLAYWRIGHT_STEP_TIMEOUT_MS ?? 8_000);

export type EnvCredentials = LoginCredentials;

/** Substitute {{username}} / {{password}} template variables from encrypted env credentials. */
export function substituteVariables(definition: TestDefinition, credentials: EnvCredentials | null): TestDefinition {
  // {{username}}/{{password}} become markers resolved at fill time by the executor - real values
  // never enter the test definition or its logs.
  if (!credentials) return definition;
  const marker = (text: string | undefined) => /\{\{\s*username\s*\}\}/i.test(text ?? "") ? "__PROOFLINE_USER__" : /\{\{\s*password\s*\}\}/i.test(text ?? "") ? "__PROOFLINE_PASS__" : text;
  return { ...definition, steps: definition.steps.map((step) => ({ ...step, target: marker(step.target)!, value: marker(step.value) })) };
}

const log = (event: string, detail?: Record<string, unknown>) => console.info(JSON.stringify({ service: "ai-qa-workers", login: event, ...detail }));

/**
 * One browser + logged-in context for a whole run (plan or verification): credentials, fixtures, the
 * saved session, the per-host limiter, access-wall bypass headers, and the session keeper that logs
 * in once and recovers the session when it dies mid-run.
 */
export async function openRunSession(projectId: string, environmentUrl: string) {
  const credentials = await loadCredentials(prisma, projectId, environmentUrl);
  const fixtureVars = await loadFixtureVars(prisma, projectId, environmentUrl);
  const savedSession = credentials ? await loadSessionState(prisma, projectId, environmentUrl) : undefined;
  const bypass = await loadBypassHeaders(prisma, projectId, process.env.JWT_SECRET ?? "");
  const browser = await chromium.launch({ headless: true });
  const newContext = async (storageState?: unknown) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(storageState ? { storageState: storageState as never } : {}) });
    const limiter = await installHostLimiter(context);
    // Previews behind an access wall (Vercel Deployment Protection, Cloudflare Access) need their bypass headers.
    await attachBypassHeaders(context, environmentUrl, bypass);
    return { context, limiter };
  };
  const { context, limiter } = await newContext(savedSession);
  const keeper = sessionKeeper(context, { baseUrl: environmentUrl, credentials, limiter, store: sessionStore(prisma, projectId, environmentUrl), log });
  const loginStatus = await keeper.login(Boolean(savedSession));
  return {
    browser, context, limiter, keeper, credentials, fixtureVars, loginStatus,
    /** A fresh logged-out context: login / sign-up tests must never touch the run's shared session. */
    anonymousContext: async () => (await newContext()).context,
    close: async () => { await keeper.save(); await browser.close().catch(() => undefined); }
  };
}

/** Heavy SPAs render over ~10s; poll until interactive elements appear. */
async function waitForAppRender(page: Page, timeoutMs = 20000, minVisible = 2): Promise<boolean> {
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
    if (count >= 3) return true;
    await page.waitForTimeout(1500).catch(() => undefined);
  }
  return false;
}

/** Text-node based finder: finds text inside non-leaf elements (SVG + text). */
async function treeTextClick(page: Page, target: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  while (Date.now() < deadline) {
    const clicked = await page.evaluate((pat) => {
      const re = new RegExp(pat, "i");
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = (walker.currentNode.textContent ?? "").trim();
        if (!re.test(text) || text.length > 60) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        const rect = range.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (hit) { hit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; }
      }
      return false;
    }, escaped).catch(() => false);
    if (clicked) return true;
    await page.waitForTimeout(1200).catch(() => undefined);
  }
  return false;
}

interface ApiResponse { url: string; json: unknown; at: number }

interface StepMeta { planId: string; testCaseId: string; frames: Map<string, Buffer>; vars: Map<string, string>; /** Test runs logged out on purpose: a login screen is expected, not a failure. */ anonymous?: boolean; /** JSON list responses the page fetched during this test (newest last). */ responses?: ApiResponse[]; /** When the last page-changing step started: assertResponse only accepts responses at or after it. */ actionAt?: number; /** How the last click/fill/select found its element; loose = fuzzy text match worth a warning. */ matched?: { by: string; loose: boolean }; /** Verification mode: a fuzzy/loose match fails the step instead of passing with a warning. */ strict?: boolean }

/** Replace {{name}} tokens from captured variables in a step field. */
function interpolate(text: string | undefined, meta?: StepMeta): string {
  if (!text || !meta) return text ?? "";
  return text.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (full, name) => meta.vars.get(name) ?? full);
}

/** Capture the app canvas (3D viewport); falls back to the full page when no canvas is visible. */
async function captureCanvasShot(page: Page): Promise<Buffer> {
  try {
    const canvas = page.locator("canvas").first();
    if (await canvas.isVisible({ timeout: 2000 }).catch(() => false)) return await canvas.screenshot({ timeout: 15000 });
    return await page.screenshot({ timeout: 15000 });
  } catch {
    return page.screenshot({ timeout: 15000 });
  }
}

/**
 * Deterministic diff of two screenshots: returns how much changed and both images
 * cropped+enlarged to the changed region. Small decorations (a sleeve flag in a big
 * render) are invisible to the vision model at full-page scale - the zoom makes the
 * judgment tractable. Returns crops=null when sizes differ (can't align) and a tiny
 * changedRatio when the images are effectively identical.
 */
async function zoomToChange(refBuf: Buffer, curBuf: Buffer): Promise<{ crops: [Buffer, Buffer] | null; changedRatio: number }> {
  const [refRaw, curRaw] = await Promise.all([
    sharp(refBuf).raw().toBuffer({ resolveWithObject: true }),
    sharp(curBuf).raw().toBuffer({ resolveWithObject: true })
  ]);
  const { width, height, channels } = refRaw.info;
  if (width !== curRaw.info.width || height !== curRaw.info.height) return { crops: null, changedRatio: 1 };
  const stepX = Math.max(1, Math.floor(width / 600));
  const stepY = Math.max(1, Math.floor(height / 600));
  let minX = width, minY = height, maxX = -1, maxY = -1, changed = 0, total = 0;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = (y * width + x) * channels;
      const diff = Math.abs(refRaw.data[i] - curRaw.data[i]) + Math.abs(refRaw.data[i + 1] - curRaw.data[i + 1]) + Math.abs(refRaw.data[i + 2] - curRaw.data[i + 2]);
      total++;
      if (diff > 45) {
        changed++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const changedRatio = changed / Math.max(1, total);
  if (maxX < 0) return { crops: null, changedRatio };
  const pad = 40;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const scale = Math.min(4, Math.max(2, Math.round(520 / Math.max(cw, ch))));
  const crops = await Promise.all([
    sharp(refBuf).extract({ left: minX, top: minY, width: cw, height: ch }).resize(cw * scale, ch * scale, { kernel: "nearest" }).png().toBuffer(),
    sharp(curBuf).extract({ left: minX, top: minY, width: cw, height: ch }).resize(cw * scale, ch * scale, { kernel: "nearest" }).png().toBuffer()
  ]);
  return { crops: [crops[0], crops[1]], changedRatio };
}

/**
 * One vision call: judge the LAST image against the expectation, with any earlier
 * images as REFERENCE frames. Model selection is the caller's: presence-style
 * single-image gates run on the cheap OPENAI_MODEL, while fine-grained reference
 * comparisons (orientation of a small decoration) need VISION_MODEL.
 */
async function judgeScreenshot(images: Buffer[], expectation: string, modelOverride?: string): Promise<{ pass: boolean; reason: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("AI visual check needs OPENAI_API_KEY configured");
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = modelOverride ?? process.env.VISION_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const content: unknown[] = [{
    type: "text",
    text: images.length > 1
      ? `Expectation: ${expectation}\nImage 1 is the REFERENCE state. The LAST image is the CURRENT state to judge.`
      : `Expectation: ${expectation}`
  }];
  for (const image of images) content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } });
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: "system", content: "You are a strict QA verifier. Judge ONLY whether the screenshot(s) satisfy the stated expectation; ignore unrelated UI details. Compare the CURRENT (last) image against REFERENCE images when provided. Reply with a single JSON object: {\"pass\": boolean, \"reason\": string}. The reason is one sentence." },
        { role: "user", content }
      ]
    })
  });
  if (!res.ok) throw new Error(`Vision model request failed with status ${res.status}`);
  const data: any = await res.json();
  const text: string = data?.choices?.[0]?.message?.content ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Vision model returned no verdict: ${text.slice(0, 140)}`);
  const parsed = JSON.parse(match[0]) as { pass?: boolean; reason?: string };
  return { pass: Boolean(parsed.pass), reason: parsed.reason || (parsed.pass ? "expectation satisfied" : "expectation not satisfied") };
}

/** Evidence is best-effort: never fail a step because its screenshot could not be stored. */
async function saveEvidence(meta: StepMeta | undefined, label: string, body: Buffer, contentType = "image/png"): Promise<void> {
  if (!meta) return;
  const extension = contentType === "image/jpeg" ? "jpg" : "png";
  await createArtifact(meta.planId, meta.testCaseId, "SCREENSHOT", `${meta.testCaseId}-${label}-${Date.now()}.${extension}`, body, contentType).catch(() => undefined);
}

/** AI visual assertion: capture the app canvas and let the vision model judge it, optionally against a named reference frame. */
async function assertVisual(page: Page, step: TestStep, meta?: StepMeta): Promise<void> {
  const frameName = step.value?.trim();
  const reference = frameName && meta ? meta.frames.get(frameName) : undefined;
  if (frameName && meta && !reference) {
    throw new Error(`Reference frame "${frameName}" was not captured in this run. Add a screenshot step named "${frameName}" before this assert.`);
  }
  // Let render animations (e.g. a flip tween) settle before judging.
  await page.waitForTimeout(2500);
  const buffer = await captureCanvasShot(page);
  let images = [buffer];
  // Reference comparisons need the stronger vision model; single-image gates (presence checks) run on the cheap default.
  const cheapModel = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  let model = cheapModel;
  if (reference) {
    const { crops, changedRatio } = await zoomToChange(reference, buffer);
    if (changedRatio < 0.0002) {
      throw new Error("Visual check failed: no visual change detected between the reference frame and the current state (the two captures are pixel-identical), so the expected transformation did not render.");
    }
    images = crops ?? [reference, buffer];
    model = process.env.VISION_MODEL ?? cheapModel;
  }
  // One retry: vision calls fail transiently far more often than they disagree.
  const verdict = await judgeScreenshot(images, step.target, model)
    .catch(() => judgeScreenshot(images, step.target, model))
    .catch((error) => { throw new Error(`AI visual check could not run: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)); });
  // Evidence: exactly the image the model judged, so users can audit the verdict.
  await saveEvidence(meta, "visual", buffer);
  if (!verdict.pass) throw new Error(`Visual check failed: ${verdict.reason}`);
}

/** Mid-run named frame: capture the canvas so a later visual assert can compare against it. */
async function captureFrame(page: Page, step: TestStep, meta?: StepMeta): Promise<void> {
  const name = step.target.trim() || `frame-${Date.now()}`;
  // Open modals would pollute the frame (e.g. an art gallery covering the canvas) —
  // wait for dialogs to clear, then let renders settle, before capturing.
  await page.locator("[role=dialog]").first().waitFor({ state: "hidden", timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
  const buffer = await captureCanvasShot(page);
  meta?.frames.set(name, buffer);
  await saveEvidence(meta, `frame-${name.replace(/[^a-zA-Z0-9-]+/g, "-")}`, buffer);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

/**
 * Deterministic render check: sample the canvas inside a percent region and
 * verify the samples match the expected color by HUE with real saturation —
 * 3D lighting scales lightness (a shadowed orange is dark orange), so raw
 * channel comparison cannot work; hue is what survives shading. Pure in-page
 * pixel reads and arithmetic — no AI involved.
 */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0));
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s: sat, l };
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

async function assertColorProbe(page: Page, step: TestStep, meta?: StepMeta): Promise<void> {
  const expected = hexToRgb(step.value ?? "");
  if (!expected) throw new Error(`assert color needs a hex value like "#0d5ea0", got "${step.value}"`);
  const region = step.region;
  if (!region || [region.x, region.y, region.w, region.h].some((n) => !Number.isFinite(n))) {
    throw new Error("assert color needs a region (percent x, y, w, h) — use Pick region in the editor.");
  }
  const expectedHsl = rgbToHsl(expected.r, expected.g, expected.b);
  // Achromatic expected (white/grey/black): samples must be too, and not wildly bright/dark. Otherwise hue + real saturation.
  const judge = (points: any[]) => points.map((p: any) => {
    const { h, s, l } = rgbToHsl(p.sample[0], p.sample[1], p.sample[2]);
    const ok = expectedHsl.s < 0.12 ? (s < 0.18 && l > 0.12 && l < 0.95) : (hueDistance(h, expectedHsl.h) <= 20 && s >= Math.max(0.18, expectedHsl.s * 0.4));
    return { ...p, ok, hsl: { h, s, l } };
  });
  const selector = step.target.trim() && step.target.trim() !== "" ? step.target.trim() : "canvas";
  // Textures/colors land on the model seconds after navigation (async design
  // load) — poll the sample until it passes or the budget runs out.
  const deadline = Date.now() + 30000;
  let samples: any = null;
  while (Date.now() < deadline) {
    samples = await page.evaluate(({ selector, region }) => {
    const canvas = document.querySelector(selector) as HTMLCanvasElement | null;
    if (!canvas || !canvas.width) return { error: `No canvas matches "${selector}".` };
    const scratch = document.createElement("canvas");
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const ctx = scratch.getContext("2d");
    if (!ctx) return { error: "Canvas 2D context unavailable." };
    // Draw on the next frame so the WebGL drawing buffer is populated.
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        try {
          ctx.drawImage(canvas, 0, 0);
          const { x, y, w, h } = region;
          const x0 = Math.round((x / 100) * canvas.width);
          const y0 = Math.round((y / 100) * canvas.height);
          const rw = Math.max(1, Math.round((w / 100) * canvas.width));
          const rh = Math.max(1, Math.round((h / 100) * canvas.height));
          const grid = 4;
          const points: Array<{ i: number; sample: [number, number, number] }> = [];
          for (let gy = 0; gy < grid; gy++) {
            for (let gx = 0; gx < grid; gx++) {
              const px = Math.min(canvas.width - 1, x0 + Math.round(((gx + 0.5) / grid) * rw));
              const py = Math.min(canvas.height - 1, y0 + Math.round(((gy + 0.5) / grid) * rh));
              const d = ctx.getImageData(px, py, 1, 1).data;
              points.push({ i: points.length, sample: [d[0], d[1], d[2]] });
            }
          }
          resolve({ points, canvasW: canvas.width, canvasH: canvas.height, crop: scratch.toDataURL("image/jpeg", 0.5) });
        } catch (err) {
          resolve({ error: `Canvas read failed: ${String(err).slice(0, 120)} (tainted or WebGL buffer cleared)` });
        }
      });
    });
  }, { selector, region });
    if (samples?.error) throw new Error(`assert color could not run: ${samples.error}`);
    if (!judge(samples.points ?? []).some((p: any) => !p.ok)) return;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(2000).catch(() => undefined);
  }
  const bad = judge(samples.points ?? []).filter((p: any) => !p.ok);
  const worst = bad.reduce((a: any, b: any) => (hueDistance(b.hsl.h, expectedHsl.h) > hueDistance(a.hsl.h, expectedHsl.h) ? b : a), bad[0] ?? { sample: [0, 0, 0], hsl: { h: 0, s: 0, l: 0 } });
  // Evidence: the exact canvas state the probe kept sampling.
  if (samples.crop) await saveEvidence(meta, "color", Buffer.from(samples.crop.split(",")[1], "base64"), "image/jpeg");
  throw new Error(`Visual color check failed: region (${region.x},${region.y},${region.w},${region.h})% is not ${step.value} — ${bad.length}/${samples.points.length} sampled points failed the hue/saturation check (waited 30s for the render). Worst sample rgb(${worst.sample.join(",")}) hsl(${Math.round(worst.hsl.h)},${Math.round(worst.hsl.s * 100)}%,${Math.round(worst.hsl.l * 100)}%).`);
}
async function assertDataAgainstApi(page: Page, step: TestStep): Promise<void> {
  const separator = (step.value ?? "").includes("==") ? "==" : "=";
  const eq = (step.value ?? "").indexOf(separator);
  if (eq < 0) throw new Error('assert data needs "json.path == expected" in the value field (e.g. "0.configuration.body_color == #0d5ea0")');
  const path = (step.value ?? "").slice(0, eq).trim();
  const expected = (step.value ?? "").slice(eq + separator.length).trim();
  if (!path || !expected) throw new Error("assert data needs both a JSON path and an expected value.");
  if (!step.target.trim()) throw new Error("assert data needs an API URL in the target field.");

  const result = await page.evaluate(async ({ rawUrl, path, expected }) => {
    const url = rawUrl.replace(/\{\{query:([^}]+)\}\}/g, (_, name) => new URLSearchParams(window.location.search).get(name) ?? "");
    const absolute = /^https?:\/\//i.test(url) ? url : new URL(url, window.location.origin).toString();
    const response = await fetch(absolute, { headers: { Accept: "application/json" } });
    if (!response.ok) return { error: `GET ${absolute} returned ${response.status}` };
    const json = await response.json().catch(() => null);
    if (json === null) return { error: `GET ${absolute} returned non-JSON body` };
    let value: any = json;
    for (const key of path.split(".")) {
      if (value == null) { value = undefined; break; }
      if (key.startsWith("json:")) {
        // Apps commonly store structured config as a JSON string column
        // (e.g. the customizer's config_data) — parse it and continue.
        try { value = JSON.parse(value[key.slice(5)]); } catch { value = undefined; }
      } else {
        value = value[key];
      }
    }
    return { absolute, actual: value === undefined ? "<undefined>" : String(value), expected, url: window.location.href };
  }, { rawUrl: step.target.trim(), path, expected });

  if (result?.error) throw new Error(`assert data failed: ${result.error}`);
  const actual = String(result.actual ?? "").trim();
  // Hex colors and similar enums arrive in arbitrary casing from APIs — compare case-insensitively.
  const matched = /^#?[0-9a-f]{3,8}$/i.test(expected) || /^#[0-9a-f]{3,8}$/i.test(actual)
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
  if (!matched) {
    throw new Error(`assert data failed: ${path} is "${actual}" but expected "${expected}" (from ${result.absolute})`);
  }
}

/**
 * assertResponse: check a rule against the list the app itself fetched after the previous action
 * (recorded by the page listener in runTestCase), so it works with any auth scheme and stays true as data moves.
 */
async function assertResponseRule(page: Page, step: TestStep, meta?: StepMeta): Promise<void> {
  const rule = parseResponseRule(step.value ?? "");
  if (!rule) throw new Error(`assertResponse needs a rule in the value field: "all <field> == <value>", "count >= <n>" or "shown <field>" (got "${step.value ?? ""}")`);
  if (!step.target.trim()) throw new Error("assertResponse needs the API path in the target field (e.g. /api/orders).");
  const since = meta?.actionAt ?? 0;
  const latest = () => (meta?.responses ?? []).filter((entry) => entry.at >= since && matchesApiCall(step.target, "GET", entry.url)).at(-1);
  const deadline = Date.now() + stepTimeoutMs;
  while (!latest() && Date.now() < deadline) await page.waitForTimeout(250);
  if (!latest()) {
    const seen = [...new Set((meta?.responses ?? []).filter((entry) => entry.at >= since).map((entry) => entry.url.replace(/^https?:\/\/[^/]+/i, "").split("?")[0]))];
    throw new Error(`assertResponse: the app made no request matching "${step.target}" after the previous step (it may filter in the browser). Requests seen: ${seen.length ? seen.slice(0, 8).join(" | ") : "(none)"}.`);
  }
  await page.waitForTimeout(400); // a burst (typing without a debounce) fires several requests: judge the last
  const body = latest()!.json;
  const text = () => (rule.kind === "shown" ? page.evaluate(() => document.body.innerText).catch(() => "") : Promise.resolve(""));
  let result = evaluateResponseRule(rule, body, await text());
  // The page may still be rendering the rows the response carried.
  for (const end = Date.now() + 4000; !result.ok && rule.kind === "shown" && Date.now() < end;) {
    await page.waitForTimeout(500);
    result = evaluateResponseRule(rule, body, await text());
  }
  if (!result.ok) throw new Error(`assertResponse ${step.target} "${step.value}" failed: ${result.message}.`);
  if (meta) meta.matched = { by: "app response", loose: false };
}

async function executeStep(page: Page, step: TestStep, baseUrl: string, credentials?: EnvCredentials | null, meta?: StepMeta) {
  // Captured variables ({{name}}) resolve once here, for every action.
  step = { ...step, target: interpolate(step.target, meta), value: interpolate(step.value, meta) };
  const timeout = { timeout: stepTimeoutMs };
  // Many apps render the same text twice (a mobile-only card plus a desktop table, each toggled by a
  // CSS breakpoint): .first() in DOM order can resolve to the one that's correctly hidden at this
  // viewport while an identical, visible one sits right after it. Scoping to :visible first fixes that
  // without changing any of the matching strategies below.
  const onlyVisible = (locator: ReturnType<Page["locator"]>) => locator.and(page.locator(":visible"));
  // A visible label NOT linked to its control (no for/id, not wrapping it - common in React forms):
  // the first field after the element whose own text is the label, ignoring a required-marker "*".
  const afterLabelText = (label: string, fields: string) => {
    const text = label.replace(/\s*\*\s*$/, "").trim().replace(/"/g, "");
    const fieldTest = fields.split(",").map((tag) => `self::${tag.trim()}`).join(" or ");
    return page.locator(`xpath=//*[self::label or self::span or self::p or self::div][not(*[self::input or self::textarea or self::select])][normalize-space(translate(., "*", ""))="${text}"]/following::*[${fieldTest}][1]`);
  };
  if (step.action === "navigate") {
    // AI-authored tests may use route-relative targets ("/uploads"); resolve
    // them against the run's environment URL before navigating.
    const target = /^https?:\/\//i.test(step.target) ? step.target : new URL(step.target, baseUrl).toString();
    const result = await page.goto(target, { waitUntil: "domcontentloaded", timeout: stepTimeoutMs * 2 });
    // Heavy client-rendered apps render over ~10s — poll until interactive.
    await waitForAppRender(page, 20000, 2).catch(() => undefined);
    // A logged-in test that lands on a login screen did not reach its page: fail here, not on a later
    // step that happens to match text on the login page.
    if (!meta?.anonymous && !isAuthRoute(target)) {
      if (await onLoginScreen(page)) {
        throw new Error(`Opened ${target} but the app showed a login screen${page.url() !== target ? ` (now at ${page.url()})` : ""}, so the page was never reached. The test needs a logged-in session.`);
      }
    }
    return result;
  }
  if (step.action === "screenshot") return captureFrame(page, step, meta);
  if (step.action === "wait") {
    // Fixed pause: seconds in the target field (e.g. "5"). Capped so a typo
    // cannot stall the queue; condition-based `waitFor` remains the better tool
    // when there is something to wait FOR.
    const seconds = Number((step.target ?? "").trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Wait step needs a positive number of seconds in the target field (e.g. "5")');
    await page.waitForTimeout(Math.min(seconds, 60) * 1000);
    return;
  }
  if (step.action === "assertColor") return assertColorProbe(page, step, meta);
  if (step.action === "assertData") return assertDataAgainstApi(page, step);
  if (step.action === "assertResponse") return assertResponseRule(page, step, meta);
  if (step.action === "capture") {
    // Read a value out of the page (regex with one capture group over the body
    // text) and store it as a variable for later {{name}} interpolation. Polls:
    // async saves often surface their identifiers seconds after the action.
    const variable = (step.value ?? "").trim();
    if (!variable) throw new Error('capture needs a variable name in the value field (e.g. "designNumber")');
    // "url:<regex>" reads the pattern from the current page URL instead of the body text - a
    // setup-chain scenario needs the id a create action's own navigate/redirect just assigned.
    const urlCapture = step.target.startsWith("url:");
    const pattern = urlCapture ? step.target.slice(4) : step.target;
    const deadline = Date.now() + 30000;
    let match: RegExpExecArray | null = null;
    while (Date.now() < deadline) {
      const text = urlCapture ? page.url() : await page.evaluate(() => document.body.innerText);
      match = new RegExp(interpolate(pattern, meta), "i").exec(text);
      if (match) break;
      await page.waitForTimeout(1000).catch(() => undefined);
    }
    if (!match) throw new Error(`capture failed: pattern "${step.target}" not found within 30s.`);
    meta?.vars.set(variable, match[1] ?? match[0]);
    return;
  }
  if (step.action === "click") {
    // Recorder-captured css: targets replay via locator directly.
    if (step.target.startsWith("css:")) return page.locator(step.target.slice(4)).first().click(timeout);
    // A role recorded during a prior verified pass: the one lookup that matters, nothing fuzzy.
    if (step.role) {
      await onlyVisible(page.getByRole(step.role as never, { name: step.target, exact: true })).first().click(timeout);
      if (meta) meta.matched = { by: `role · ${step.role}`, loose: false };
      return;
    }
    // Resolution chain: exact button, exact link, exact text, then a forgiving
    // case-insensitive partial-text match ("DECORATION" hits "5 DECORATION").
    // Each stage must WAIT its slice of the budget — count() checks evaluate
    // instantly and miss elements on slow client-rendered pages.
    const stageTimeout = Math.max(3000, Math.floor(stepTimeoutMs / 2));
    // Generic descriptor words the model pads targets with ("decoration type
    // Hyper Twill", "RIGHT SLEEVE location") — stripped from the ends for the
    // final fallback so the distinctive label ("Hyper Twill") gets matched.
    const genericWords = new Set(["the", "a", "an", "on", "of", "type", "option", "any", "from", "sidebar", "menu", "button", "click", "choose", "select", "location", "side", "step", "tab"]);
    const trimGeneric = (value: string) => {
      const words = value.split(/\s+/);
      while (words.length > 1 && genericWords.has(words[0].toLowerCase())) words.shift();
      while (words.length > 1 && genericWords.has(words[words.length - 1].toLowerCase())) words.pop();
      return words.join(" ");
    };
    const trimmed = trimGeneric(step.target);
    const stages = [
      () => onlyVisible(page.getByRole("button", { name: step.target, exact: true })).first().click({ timeout: stageTimeout }),
      () => onlyVisible(page.getByRole("link", { name: step.target, exact: true })).first().click({ timeout: stageTimeout }),
      () => onlyVisible(page.getByText(step.target, { exact: true })).first().click({ timeout: stageTimeout }),
      () => onlyVisible(page.getByText(new RegExp("^" + step.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i"))).first().click({ timeout: stageTimeout }),
      () => onlyVisible(page.getByText(new RegExp(step.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))).first().click({ timeout: stageTimeout }),
      ...(trimmed && trimmed !== step.target ? [() => onlyVisible(page.getByText(new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))).first().click({ timeout: stageTimeout })] : [])
    ];
    // Index >= 3 are fuzzy text matches: they work, but a wrong element can match, so the live log flags them.
    const stageNames = ["button role · exact", "link role · exact", "text · exact", "text · case-insensitive", "text · partial", "text · trimmed words"];
    // Strict mode (dry-run verification): a loose match is a defect to report, not a pass to accept.
    const usableStages = meta?.strict ? stages.slice(0, 3) : stages;
    let lastError: unknown;
    for (const [index, stage] of usableStages.entries()) {
      try {
        const done = await stage();
        if (meta) meta.matched = { by: stageNames[index] ?? "text", loose: index >= 3 };
        return done;
      } catch (error) {
        lastError = error;
      }
    }
    // Row actions (Edit/Delete/Void) often live behind an icon-only "..." menu per table row: open the
    // first row's menu and click the exact item. ponytail: always the first row; a scenario needing a
    // specific record should open it first (row click / detail page).
    const rowMenu = onlyVisible(page.locator("tbody tr [aria-haspopup=menu], [role=row] [aria-haspopup=menu]")).first();
    if (await rowMenu.count().catch(() => 0)) {
      try {
        await rowMenu.click({ timeout: 3000 });
        await onlyVisible(page.getByRole("menuitem", { name: step.target, exact: true })).first().click({ timeout: 3000 });
        if (meta) meta.matched = { by: "row action menu", loose: false };
        return;
      } catch (error) {
        lastError = error;
        await page.keyboard.press("Escape").catch(() => undefined);
      }
    }
    // Nothing matched: fail with what IS on the page so the run is self-diagnosing.
    // A string, not a function: under tsx a named inner helper is compiled to __name(...), which throws in the page.
    const visible = await page.evaluate<string[]>(`(() => {
      const found = [];
      for (const el of Array.from(document.querySelectorAll("button, a, [role=button]"))) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const label = (el.textContent || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
        if (label && label.length <= 60 && !found.includes(label)) found.push(label);
      }
      return found.slice(0, 12);
    })()`).catch(() => [] as string[]);
    if (meta?.strict) {
      const lastMessage = lastError instanceof Error ? ` Last stage error: ${lastError.message.split("\n")[0]}` : "";
      throw new Error(`No exact clickable element matching "${step.target}" (strict mode refuses a fuzzy match). Visible buttons/links on the page: ${visible.length ? visible.join(" | ") : "(none)"}.${lastMessage}`);
    }
    // All stages missed: the app may still be rendering — re-wait and retry the
    // whole chain once, including a text-node based click (finds controls whose
    // text sits inside non-leaf elements, e.g. icon + label cards).
    const rendered = await waitForAppRender(page, 12000, 3).catch(() => false);
    if (rendered) {
      for (const [index, stage] of stages.entries()) {
        try {
          const done = await stage();
          if (meta) meta.matched = { by: stageNames[index] ?? "text", loose: index >= 3 };
          return done;
        } catch (retryError) { lastError = retryError; }
      }
    }
    if (await treeTextClick(page, step.target, 8000)) { if (meta) meta.matched = { by: "text node scan", loose: true }; return; }
    const lastMessage = lastError instanceof Error ? ` Last stage error: ${lastError.message.split("\n")[0]}` : "";
    throw new Error(`No clickable element matching "${step.target}". Visible buttons/links on the page: ${visible.length ? visible.join(" | ") : "(none)"}.${lastMessage}`);
  }
  if (step.action === "fill") {
    if (step.target.startsWith("css:")) return page.locator(step.target.slice(4)).first().fill(step.value ?? "", timeout);
    if (step.role) {
      await onlyVisible(page.getByRole(step.role as never, { name: step.target, exact: true })).first().fill(step.value ?? "", timeout);
      if (meta) meta.matched = { by: `role · ${step.role}`, loose: false };
      return;
    }
    // Credential markers: {{username}}/{{password}} targets resolve to the
    // generic username/password inputs on the page.
    if (credentials && (step.target === "__PROOFLINE_USER__" || step.target === "__PROOFLINE_PASS__")) {
      // The login modal can appear asynchronously after a gate click — poll
      // generously (25s) for the field before filling.
      const isUser = step.target === "__PROOFLINE_USER__";
      const selector = isUser ? 'input:not([type="password"]):visible, input[type="email"]:visible' : 'input[type="password"]:visible';
      // .last() - login modals mount at the end of the DOM; first() can hit
      // inputs on the page behind the overlay.
      const field = page.locator(selector).last();
      await field.waitFor({ state: "visible", timeout: 25000 }).catch(() => undefined);
      await field.fill(isUser ? credentials.username : credentials.password, { timeout: 10000 });
      // Many apps validate the email on blur: Tab so the field registers before the password step.
      if (isUser) await page.keyboard.press("Tab").catch(() => undefined);
      return;
    }
    // {{username}} / {{password}} values resolve to the environment secret, then fill like any other value.
    const fillValue = step.value === "__PROOFLINE_USER__" ? credentials?.username ?? "" : step.value === "__PROOFLINE_PASS__" ? credentials?.password ?? "" : step.value ?? "";
    // The crawler lists inputs by placeholder / aria-label / name / type, so resolve the same ways the
    // model can name them: label, placeholder, accessible name, then name / id / type attribute.
    const quoted = JSON.stringify(step.target);
    const fillNames = ["label · exact", "label", "placeholder", "accessible name", "attribute name / id / type", "unlinked label"];
    const fillStages = [
      () => onlyVisible(page.getByLabel(step.target, { exact: true })).first(),
      () => onlyVisible(page.getByLabel(step.target)).first(),
      () => onlyVisible(page.getByPlaceholder(step.target)).first(),
      () => onlyVisible(page.getByRole("textbox", { name: step.target })).first(),
      () => onlyVisible(page.locator(`input[aria-label=${quoted} i], textarea[aria-label=${quoted} i], input[name=${quoted} i], input[id=${quoted} i], input[type=${quoted} i]`)).first(),
      () => onlyVisible(afterLabelText(step.target, "input, textarea")).first()
    ];
    const stageTimeout = Math.max(2000, Math.floor(stepTimeoutMs / fillStages.length));
    const deadline = Date.now() + stepTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      for (const [index, stage] of fillStages.entries()) {
        const field = stage();
        if (await field.count().catch(() => 0)) {
          try {
            await field.fill(fillValue, { timeout: stageTimeout });
            if (meta) meta.matched = { by: fillNames[index] ?? "input", loose: false };
            return;
          } catch (error) { lastError = error; }
        }
      }
      await page.waitForTimeout(500).catch(() => undefined);
    }
    const fields = await page.evaluate(() => Array.from(document.querySelectorAll("input:not([type=hidden]), textarea")).filter((el) => el.getBoundingClientRect().width > 0).map((el) => {
      const field = el as HTMLInputElement;
      return (field.placeholder || field.getAttribute("aria-label") || field.name || field.type || "").slice(0, 40);
    }).filter(Boolean).slice(0, 12)).catch(() => [] as string[]);
    throw new Error(`No input matching "${step.target}" (tried label, placeholder, accessible name, name/id/type). Visible inputs: ${fields.length ? fields.join(" | ") : "(none)"}.${lastError instanceof Error ? ` Last error: ${lastError.message.split("\n")[0]}` : ""}`);
  }
  if (step.action === "select") {
    // A form dropdown (target = field label, value = option): native <select> or a combobox/listbox.
    // Falls through to the choice-click chain below when no such field exists.
    if (step.value !== undefined && step.value !== "") {
      const any = step.value === "{{any}}";
      const label = step.target.replace(/\s*\*\s*$/, "");
      // A toggle-button group (role=group, aria-label = field label): the value is one of its buttons.
      const group = onlyVisible(page.getByRole("group", { name: label })).first();
      if (await group.count().catch(() => 0)) {
        const buttons = group.getByRole("button");
        const button = any ? buttons.first() : buttons.filter({ hasText: new RegExp(step.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first();
        if (await button.count().catch(() => 0)) {
          await button.click(timeout);
          if (meta) meta.matched = { by: "toggle group", loose: false };
          return;
        }
      }
      const candidates = [page.getByLabel(step.target, { exact: true }), page.getByRole("combobox", { name: step.target }), page.getByLabel(label, { exact: true }), page.getByRole("combobox", { name: label }), afterLabelText(step.target, "select, button, input")];
      for (const candidate of candidates) {
        const field = onlyVisible(candidate).first();
        if (!(await field.count().catch(() => 0))) continue;
        if (await field.evaluate((el: Element) => el.tagName === "SELECT").catch(() => false)) {
          const value = any
            ? await field.evaluate((el: Element) => Array.from((el as HTMLSelectElement).options).find((option) => option.value && !option.disabled)?.value ?? null)
            : null;
          if (any && value === null) throw new Error(`Dropdown "${step.target}" has no selectable option`);
          await field.selectOption(any ? value! : { label: step.value }, timeout);
        } else {
          const isInput = await field.evaluate((el: Element) => el.tagName === "INPUT").catch(() => false);
          await field.click(timeout);
          // The field names its own popup (aria-controls): pick from inside it - an autocomplete popover's
          // results are often plain buttons, not role=option. Without one, any visible role=option.
          const popup = await field.getAttribute("aria-controls").catch(() => null);
          const choices = (popup ? page.locator(`[id="${popup.replace(/"/g, '\\"')}"]`).locator("[role=option], [cmdk-item], button, li") : page.getByRole("option"))
            .filter({ hasNot: page.locator("[aria-disabled=true]") });
          const options = onlyVisible(choices);
          // A search-as-you-type field (autocomplete) shows nothing until typed into.
          if (isInput && !(await options.first().waitFor({ timeout: 2000 }).then(() => true).catch(() => false))) {
            await field.pressSequentially(any ? "a" : step.value, { delay: 40 });
          }
          const option = any ? options.first() : options.filter({ hasText: step.value }).first();
          await option.click({ timeout: 5000 });
        }
        if (meta) meta.matched = { by: "form dropdown", loose: false };
        return;
      }
    }
    if (step.role) {
      await onlyVisible(page.getByRole(step.role as never, { name: step.target, exact: true })).first().click({ timeout: 3000 });
      if (meta) meta.matched = { by: `role · ${step.role}`, loose: false };
      return;
    }
    // "Select X" usually means choosing a visible option (card, tile, list item),
    // not necessarily an HTML dropdown. Try click-style first, dropdown second.
    const escapedTarget = step.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Token stages: app spellings often differ ("HYPR" vs "Hyper") — match any
    // significant word of the target case-insensitively.
    const significantWords = step.target.split(/\s+/).map((w) => w.replace(/[^a-zA-Z0-9]/g, "")).filter((w) => w.length >= 4);
    const allChoiceStages = [
      () => onlyVisible(page.getByText(step.target, { exact: true })).first().click({ timeout: 3000 }),
      () => onlyVisible(page.getByText(new RegExp("^" + escapedTarget + "$", "i"))).first().click({ timeout: 3000 }),
      () => onlyVisible(page.getByText(new RegExp(escapedTarget, "i"))).first().click({ timeout: 3000 }),
      () => onlyVisible(page.getByRole("option", { name: step.target })).first().click({ timeout: 3000 }),
      ...significantWords.map((word) => () => onlyVisible(page.getByText(new RegExp(word, "i"))).first().click({ timeout: 2500 })),
      () => page.getByLabel(step.target).first().selectOption(step.value ?? "", timeout)
    ];
    const allChoiceNames = ["text · exact", "text · case-insensitive", "text · partial", "option role", ...significantWords.map((word) => `word "${word}"`), "dropdown label"];
    // Partial text (2) and single-word matches are fuzzy; exact text, option role and the dropdown label are not.
    const isLoose = (index: number) => index === 2 || (index >= 4 && index < allChoiceStages.length - 1);
    // Strict mode (dry-run verification): drop the partial-text and single-word stages entirely.
    const choices = allChoiceStages
      .map((stage, index) => ({ stage, name: allChoiceNames[index] ?? "text", loose: isLoose(index) }))
      .filter((entry) => !meta?.strict || !entry.loose);
    for (const choice of choices) {
      try {
        const done = await choice.stage();
        if (meta) meta.matched = { by: choice.name, loose: choice.loose };
        return done;
      } catch { /* next strategy */ }
    }
    if (!meta?.strict && await treeTextClick(page, step.target, 8000)) { if (meta) meta.matched = { by: "text node scan", loose: true }; return; }
    throw new Error(`Nothing selectable matching "${step.target}"${meta?.strict ? " (strict mode refuses a fuzzy match)" : ""}. Visible buttons/links: ${await page.evaluate(() => Array.from(document.querySelectorAll("button, a, [role=button], option")).map(el => (el.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 12).join(" | "))}`);
  }
  if (step.action === "upload") {
    // AI tests reference placeholder paths; substitute a generated fixture when missing.
    let filePath = step.value ?? "";
    if (!filePath || !existsSync(filePath)) {
      const fixtureDir = join(artifactDir, ".upload-fixtures");
      mkdirSync(fixtureDir, { recursive: true });
      const safeName = filePath.split(/[\\/]/).filter(Boolean).pop() || "fixture.txt";
      filePath = join(fixtureDir, safeName);
      if (!existsSync(filePath)) writeFileSync(filePath, "proofline upload fixture\n");
    }
    const byLabel = page.getByLabel(step.target).first();
    if (await byLabel.count()) return byLabel.setInputFiles(filePath);
    return page.locator(step.target).first().setInputFiles(filePath);
  }
  if (step.action === "waitFor") return onlyVisible(page.getByText(step.target)).first().waitFor({ state: "visible", timeout: stepTimeoutMs });
  if (step.action === "assert") {
    if (step.condition === "visual") return assertVisual(page, step, meta);
    if (step.condition === "hidden") return assertNotVisible(page, step.target, stepTimeoutMs);
    if (step.condition === "urlMatches") {
      const visible = new RegExp(step.target, "i").test(page.url());
      if (!visible) throw new Error(`Expected URL to match "${step.target}" but saw ${page.url()}`);
      return;
    }
    if (step.condition === "equals") {
      const actual = await page.getByText(step.target).first().textContent();
      if (actual !== step.value) throw new Error(`Expected text "${step.target}" to equal "${step.value}" but saw "${actual}"`);
      return;
    }
    try {
      if (step.condition === "contains") {
        // Case-insensitive like getByText: CSS text-transform and the model's casing never decide a pass.
        const actual = await page.textContent("body");
        if (!actual?.toLowerCase().includes(step.target.toLowerCase())) throw new Error(`Expected page to contain "${step.target}"`);
        return;
      }
      return await onlyVisible(page.getByText(step.target)).first().waitFor({ state: "visible", timeout: stepTimeoutMs });
    } catch (error) {
      // A field's native constraint (min, required, type=email) stops the submit before the app's own
      // check runs, so the app's message never renders. The browser's rejection proves the same rule.
      const native = await nativeRejection(page);
      if (!native) throw error;
      if (meta) meta.matched = { by: `native validation · ${native}`, loose: false };
    }
    return;
  }
  throw new Error(`Unsupported test step: ${step.action}`);
}

/**
 * Records every `invalid` event: the browser fires it only when a submit (or reportValidity) is
 * blocked by a native constraint, never for a field that is merely invalid - so a test whose submit
 * step is removed (mutation check) records none. A string script: tsx's __name helper breaks evaluate.
 */
const RECORD_NATIVE_INVALID = `document.addEventListener("invalid", (event) => {
  const field = event.target;
  const label = (field.labels && field.labels[0] && field.labels[0].innerText) || field.name || field.id || "field";
  (window.__qaInvalid = window.__qaInvalid || []).push(label.replace(/\\s*\\*\\s*$/, "").trim() + ": " + field.validationMessage);
}, true);`;

/** The latest submit the browser blocked on this page, as "Field: message"; undefined when none was. */
async function nativeRejection(page: Page): Promise<string | undefined> {
  const seen = (await page.evaluate("window.__qaInvalid || []").catch(() => [])) as string[];
  return seen.at(-1);
}

interface StepOutcome { index: number; action: string; target: string; status: "PASSED" | "FAILED"; error?: string; durationMs: number; matchedBy?: string; loose?: boolean }

/** One row of the live step log shown under a running test. Never holds typed values: they may be secrets. */
interface StepLogEntry { index: number; action: string; target: string; status: "PENDING" | "RUNNING" | "PASSED" | "FAILED"; startedAt?: string; durationMs?: number; error?: string; matchedBy?: string; loose?: boolean }
const STEP_LOG_LIMIT = 200;

interface RunObservations {
  /** Non-GET or failed (4xx/5xx) API calls, newest last - what the repair prompt needs to see, not the full traffic log. */
  network: Array<{ method: string; url: string; status: number; body?: string }>;
  /** page.ariaSnapshot() at the moment of failure, capped - the repair prompt's ground truth for what was actually on screen. */
  ariaAtFailure?: string;
  /** A 429 was seen and the host limiter's retries ran out. */
  rateLimited?: boolean;
}

export async function runTestCase(
  context: any, definition: TestDefinition, planId: string, testCaseId: string, baseUrl: string,
  credentials?: EnvCredentials | null, fixtureVars?: Map<string, string>, anonymous = false,
  opts?: { strict?: boolean; observe?: boolean }
): Promise<{ status: "PASSED" | "FAILED"; error?: string; steps: StepOutcome[]; screenshotBuffer?: Buffer; observations?: RunObservations; unauthorized?: boolean }> {
  const page = await context.newPage();
  await page.addInitScript(RECORD_NATIVE_INVALID);
  const steps: StepOutcome[] = [];
  const frames = new Map<string, Buffer>();
  const vars = new Map<string, string>(fixtureVars ?? []);
  // A test's own created records get a run-unique suffix so repeat verification runs (and other
  // tests creating similar data) never collide on a "duplicate name" validation error.
  vars.set("uniq", `qa${Date.now().toString(36)}`);
  let screenshotBuffer: Buffer | undefined;
  // Live log: written after every step so the Executions page shows real progress. Best effort: never fails the test.
  const log: StepLogEntry[] = definition.steps.slice(0, STEP_LOG_LIMIT).map((step, index) => ({ index, action: step.action, target: step.target.replace("__PROOFLINE_USER__", "{{username}}").replace("__PROOFLINE_PASS__", "{{password}}").slice(0, 160), status: "PENDING" }));
  const flush = async () => {
    try {
      await prisma.executionPlanItem.update({ where: { executionPlanId_testCaseId: { executionPlanId: planId, testCaseId } }, data: { stepLog: log as never } });
    } catch { /* progress is advisory */ }
  };
  await flush();
  // JSON list responses the app fetches, for assertResponse. Bounded: newest 50, bodies under 1 MB.
  const responses: ApiResponse[] = [];
  const networkIssues: RunObservations["network"] = [];
  let rateLimited = false;
  // The app answered 401 during this test: maybe the session died (runRecovering decides), maybe the test's own point.
  let unauthorized = false;
  let actionAt = Date.now();
  page.on("response", (response: any) => {
    const request = response.request();
    if (!["fetch", "xhr"].includes(request.resourceType())) return;
    const status = response.status();
    if (status === 429) rateLimited = true;
    if (status === 401) unauthorized = true;
    if (opts?.observe && status >= 400 && networkIssues.length < 20) {
      void response.text().then((body: string) => {
        networkIssues.push({ method: request.method(), url: request.url(), status, body: body.slice(0, 500) });
      }).catch(() => networkIssues.push({ method: request.method(), url: request.url(), status }));
    }
    if (request.method() !== "GET" || status !== 200) return;
    const headers = response.headers();
    if (!String(headers["content-type"] ?? "").includes("json") || Number(headers["content-length"] ?? 0) > 1_000_000) return;
    const at = Date.now();
    void response.json().then((json: unknown) => { responses.push({ url: request.url(), json, at }); if (responses.length > 50) responses.shift(); }).catch(() => undefined);
  });
  try {
    for (const [index, step] of definition.steps.entries()) {
      const startedAt = Date.now();
      if (["navigate", "click", "fill", "select", "upload"].includes(step.action)) actionAt = startedAt;
      const entry = log[index];
      if (entry) { entry.status = "RUNNING"; entry.startedAt = new Date(startedAt).toISOString(); await flush(); }
      const meta: StepMeta = { planId, testCaseId, frames, vars, anonymous, responses, actionAt, strict: opts?.strict };
      try {
        await executeStep(page, step, baseUrl, credentials, meta);
        steps.push({ index, action: step.action, target: step.target, status: "PASSED", durationMs: Date.now() - startedAt, ...(meta.matched ? { matchedBy: meta.matched.by, loose: meta.matched.loose } : {}) });
        if (entry) {
          Object.assign(entry, { status: "PASSED", durationMs: Date.now() - startedAt, ...(meta.matched ? { matchedBy: meta.matched.by, loose: meta.matched.loose } : {}) });
          await flush();
        }
      } catch (error) {
        const message = (error instanceof Error ? error.message : "Unknown step failure").replace(/\u001b\[[0-9;]*m/g, "");
        steps.push({ index, action: step.action, target: step.target, status: "FAILED", error: message, durationMs: Date.now() - startedAt });
        if (entry) { Object.assign(entry, { status: "FAILED", durationMs: Date.now() - startedAt, error: message.slice(0, 400) }); await flush(); }
        const planDir = join(artifactDir, planId);
        mkdirSync(planDir, { recursive: true });
        screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => undefined);
        const observations: RunObservations | undefined = opts?.observe ? {
          network: networkIssues,
          ariaAtFailure: await page.ariaSnapshot({ mode: "ai" }).then((snapshot: string) => snapshot.slice(0, 8_000)).catch(() => undefined),
          ...(rateLimited ? { rateLimited: true } : {})
        } : undefined;
        return { status: "FAILED", error: `Step ${index + 1} (${step.action} "${step.target}") failed: ${steps[steps.length - 1]!.error}`, steps, screenshotBuffer, observations, ...(unauthorized ? { unauthorized } : {}) };
      }
    }
    return { status: "PASSED", steps, ...(opts?.observe ? { observations: { network: networkIssues, ...(rateLimited ? { rateLimited: true } : {}) } } : {}) };
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function processPlan(planId: string, job: Job, token?: string) {
  const plan = await prisma.executionPlan.findFirst({
    where: { id: planId },
    include: { items: { include: { testCase: true } }, project: true }
  });
  if (!plan) return;
  if (plan.status !== "QUEUED") return;

  const subscription = await prisma.subscription.findUnique({ where: { organizationId: plan.organizationId }, include: { plan: { select: { executionSlotLimit: true } } } });
  if (subscription && ["INCOMPLETE", "PAST_DUE", "BILLING_LOCKED", "CANCELED", "EXPIRED"].includes(subscription.status)) {
    await prisma.executionPlan.update({ where: { id: planId }, data: { status: "BLOCKED", completedAt: new Date() } });
    await prisma.executionPlanItem.updateMany({ where: { executionPlanId: planId, status: "QUEUED" }, data: { status: "BLOCKED", errorMessage: "Billing is locked" } });
    await reportCi(plan);
    return;
  }

  // Concurrent test slots are a plan entitlement. Dashboard runs are refused at the API when slots are full;
  // CI runs are accepted and wait here instead, so no commit is dropped.
  // ponytail: count-then-start is not atomic — two workers can both take the last slot; use a Redis semaphore per org if overshoot matters.
  const slotLimit = subscription?.plan?.executionSlotLimit ?? 5;
  const running = await prisma.executionPlan.count({ where: { organizationId: plan.organizationId, status: "RUNNING" } });
  if (running >= slotLimit) {
    await job.moveToDelayed(Date.now() + SLOT_RETRY_MS, token);
    throw new DelayedError();
  }

  // Conditional: the plan may have been canceled (or superseded by a newer commit) while it waited.
  const started = await prisma.executionPlan.updateMany({ where: { id: planId, status: "QUEUED" }, data: { status: "RUNNING", startedAt: new Date() } });
  if (!started.count) return;
  await reportCi(plan);

  const session = await openRunSession(plan.projectId, plan.environmentUrl);
  const { keeper, limiter, credentials, fixtureVars } = session;
  let passed = 0;
  let failed = 0;

  let canceled = false;
  for (const item of plan.items) {
    const definition = item.testCase.definition as unknown as TestDefinition | null;
    if (item.status !== "QUEUED") continue;
    // Honor cancel / supersede between tests rather than finishing a run nobody wants.
    if ((await prisma.executionPlan.findUnique({ where: { id: planId }, select: { status: true } }))?.status === "CANCELED") { canceled = true; break; }
    if (!definition?.steps?.length) {
      await prisma.executionPlanItem.update({ where: { executionPlanId_testCaseId: { executionPlanId: planId, testCaseId: item.testCaseId } }, data: { status: "SKIPPED", errorMessage: "The test has no executable steps", startedAt: new Date(), finishedAt: new Date() } });
      continue;
    }
    const startedAt = new Date();
    await prisma.executionPlanItem.update({ where: { executionPlanId_testCaseId: { executionPlanId: planId, testCaseId: item.testCaseId } }, data: { status: "RUNNING", startedAt } });
    const runnable = substituteVariables(definition, credentials);
    // Login / forgot-password / sign-up tests need a logged-out browser, and each gets a fresh one:
    // the plan context holds the session, and a sign-in test would log a shared anonymous context in.
    const anonymous = needsAnonymousSession(definition);
    let result: Awaited<ReturnType<typeof runTestCase>>;
    await limiter.waitUntilReady(); // the budget is per IP, so the main context's view covers anonymous ones too
    if (anonymous) {
      const testContext = await session.anonymousContext();
      try {
        result = await runTestCase(testContext, runnable, planId, item.testCaseId, plan.environmentUrl, credentials, fixtureVars, true);
      } finally {
        await testContext.close().catch(() => undefined);
      }
    } else {
      // A long plan outlives a short-lived token: recover the session and rerun instead of failing the rest.
      result = (await runRecovering(keeper, () => runTestCase(session.context, runnable, planId, item.testCaseId, plan.environmentUrl, credentials, fixtureVars, false), firstPage(definition))).result;
    }
    // Name the root cause: a logged-in test failing after the plan's login failed is a credentials problem, not an app bug.
    if (result.status === "FAILED" && keeper.status() === "failed" && !anonymous) {
      result.error = `Login with the environment's saved credentials failed, so this test ran logged out. Fix the login in Settings > Environments. ${result.error ?? ""}`.trim();
    }
    const finishedAt = new Date();
    await prisma.executionPlanItem.update({
      where: { executionPlanId_testCaseId: { executionPlanId: planId, testCaseId: item.testCaseId } },
      data: {
        status: result.status,
        errorMessage: result.error,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        finishedAt
      }
    });
    if (result.screenshotBuffer) {
      await createArtifact(planId, item.testCaseId, "SCREENSHOT", `${item.testCaseId}-failure.png`, result.screenshotBuffer, "image/png");
    }
    const logBody = Buffer.from(JSON.stringify({ title: item.testCase.title, result }, null, 2), "utf8");
    await createArtifact(planId, item.testCaseId, "LOG", `${item.testCaseId}-steps.json`, logBody, "application/json");
    if (result.status === "PASSED") passed += 1; else failed += 1;
  }

  if (canceled) {
    await prisma.executionPlanItem.updateMany({ where: { executionPlanId: planId, status: "QUEUED" }, data: { status: "SKIPPED", errorMessage: "Run was canceled" } });
  } else {
    // Only a still-running plan gets a verdict; a cancel that landed during the last test wins.
    await prisma.executionPlan.updateMany({ where: { id: planId, status: "RUNNING" }, data: { status: failed > 0 ? "FAILED" : "PASSED", completedAt: new Date() } });
  }
  await reportCi(plan);
  await session.close();
  console.info(JSON.stringify({ service: "ai-qa-workers", planId, passed, failed }));
}

async function main() {
  mkdirSync(artifactDir, { recursive: true });
  // The module-level `ciReports` Queue (constructed above, so every importer gets it) already
  // moves this connection out of "wait" the moment anything touches it - by the time main() runs,
  // connect() has usually already been called implicitly and IORedis throws on a second call.
  // Only call it ourselves when nothing has yet.
  if (connection.status === "wait") await connection.connect();
  else await connection.ping(); // still make sure it is actually usable before registering workers on it
  const runner = new Worker(
    "executions",
    async (job, token) => processPlan(job.data.planId as string, job, token),
    { connection, concurrency }
  );
  const scheduler = new Queue("executions", { connection });
  await scheduler.waitUntilReady();
  console.info(JSON.stringify({ service: "ai-qa-workers", status: "ready", queue: "executions", concurrency }));

  // One stream per environment host by default: parallel verification contexts sharing one saved
  // session can invalidate each other's tokens if the app rotates them on refresh.
  const verifyConcurrency = Math.max(1, Number(process.env.VERIFY_PARALLEL ?? 1));
  const verifier = new Worker(
    "verifications",
    async (job) => processVerification(job.data.runId as string, job.data.round as 1 | 2, connection),
    { connection, concurrency: verifyConcurrency }
  );
  console.info(JSON.stringify({ service: "ai-qa-workers", status: "ready", queue: "verifications", concurrency: verifyConcurrency }));

  const shutdown = async () => {
    await runner.close();
    await verifier.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(JSON.stringify({ service: "ai-qa-workers", error: error instanceof Error ? error.message : error }));
    process.exitCode = 1;
  });
}
