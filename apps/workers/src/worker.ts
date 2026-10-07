import { Worker, Queue } from "bullmq";
import IORedis from "ioredis";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { chromium, type Page } from "playwright";
import sharp from "sharp";
import type { TestDefinition, TestStep } from "@ai-qa/test-dsl";

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6380", { maxRetriesPerRequest: null });
const prisma = new PrismaClient();
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

interface EnvCredentials { username: string; password: string; loginUrl: string | null; loginTriggerSelector: string | null; usernameSelector: string | null; passwordSelector: string | null; submitSelector: string | null }

async function loadCredentials(projectId: string, environmentUrl: string): Promise<EnvCredentials | null> {
  try {
    // Prefer a credential-bearing environment: URL match first, then any on the
    // project (a second env can share the same URL without credentials).
    const withCreds = { usernameEnc: { not: null }, passwordEnc: { not: null } };
    const environment = await prisma.environmentProfile.findFirst({
      where: { projectId, url: environmentUrl, ...withCreds }
    }) ?? await prisma.environmentProfile.findFirst({ where: { projectId, ...withCreds } });
    if (!environment?.usernameEnc || !environment?.usernameIv || !environment?.usernameTag || !environment?.passwordEnc || !environment?.passwordIv || !environment?.passwordTag) return null;
    const key = createHash("sha256").update(process.env.JWT_SECRET ?? "").digest();
    const open = (enc: string, iv: string, tag: string) => {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(enc, "base64")), decipher.final()]).toString("utf8");
    };
    const uEnc = environment.usernameEnc, uIv = environment.usernameIv, uTag = environment.usernameTag;
    const pEnc = environment.passwordEnc, pIv = environment.passwordIv, pTag = environment.passwordTag;
    return {
      username: open(uEnc, uIv, uTag),
      password: open(pEnc, pIv, pTag),
      loginUrl: environment.loginUrl,
      loginTriggerSelector: environment.loginTriggerSelector ?? null,
      usernameSelector: environment.usernameSelector,
      passwordSelector: environment.passwordSelector,
      submitSelector: environment.submitSelector
    };
  } catch {
    return null;
  }
}

/** Substitute {{username}} / {{password}} template variables from encrypted env credentials. */
function substituteVariables(definition: TestDefinition, credentials: EnvCredentials | null): TestDefinition {
  // {{username}}/{{password}} become markers resolved at click-time by the
  // executor (generic username/password inputs) — real values never enter the
  // test definition or its logs.
  if (credentials) {
    return {
      ...definition,
      steps: definition.steps.map((step) => ({
        ...step,
        target: /\{\{\s*username\s*\}\}/i.test(step.target) ? "__PROOFLINE_USER__" : /\{\{\s*password\s*\}\}/i.test(step.target) ? "__PROOFLINE_PASS__" : step.target,
        value: /\{\{\s*username\s*\}\}/i.test(step.value ?? "") ? "__PROOFLINE_USER__" : /\{\{\s*password\s*\}\}/i.test(step.value ?? "") ? "__PROOFLINE_PASS__" : step.value
      }))
    };
  }
  return definition;
}

/**
 * Login once per plan: perform the environment's login flow in a throwaway
 * context and capture the authenticated session (cookies + localStorage) so
 * every test in the run reuses it instead of logging in individually.
 */
/** After email blur, the app fetches the account list async - wait for the dropdown. */
async function waitForAccountList(page: Page, timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate(() => {
      const selectVisible = Array.from(document.querySelectorAll("select")).some((el) => el.getBoundingClientRect().width > 0);
      const accountText = /ACCOUNT/i.test(document.body.innerText);
      return selectVisible || accountText;
    }).catch(() => false);
    if (found) return;
    await page.waitForTimeout(800).catch(() => undefined);
  }
}

async function loginOnce(page: Page, credentials: EnvCredentials, baseUrl: string): Promise<void> {
  // Site loads progressively (5-30s). Poll for full wizard render, then mirror
  // the working manual sequence. All clicks use EXACT text matching - substring
  // matching hits panel headers instead of the actual cards.
  const attempt = async (): Promise<void> => {
    const target = new URL(credentials.loginUrl?.trim() || "/", baseUrl).toString();
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => undefined);
    // The app persists wizard-step state in localStorage, so a reused context can
    // boot on a later wizard step and the Next x4 sequence overshoots DECORATION.
    // Clear storage on-origin (after goto, so we are on the app's origin) and
    // reload - the wizard then always starts at FABRIC. This runs pre-login only,
    // so the auth the login click sets afterwards is never wiped.
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } }).catch(() => undefined);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => undefined);
    await page.waitForTimeout(12000);
    const passwordInput = page.locator(credentials.passwordSelector || 'input[type="password"]').first();
    const passwordVisible = async () => passwordInput.isVisible().catch(() => false);

    const clickExact = async (pattern: string) => {
      const el = page.getByText(new RegExp("^" + pattern + "$", "i")).first();
      if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 5000 }).catch(() => undefined); await page.waitForTimeout(1800); return true; }
      // some labels carry extra words (e.g. "5 DECORATION") - partial as fallback
      const el2 = page.getByText(new RegExp(pattern, "i")).first();
      if (await el2.isVisible().catch(() => false)) { await el2.click({ timeout: 5000 }).catch(() => undefined); await page.waitForTimeout(1800); return true; }
      return false;
    };

    // Wizard: advance to the DECORATION panel. A blind Next x4 overshoots when a
    // click lands mid-transition (Product Rack / summary), so instead click Next
    // only until the DECORATION panel's decoration-type card is actually there -
    // and step back with Previous if we ever land on the summary.
    const startBody = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 160)).catch(() => "");
    console.info(JSON.stringify({ service: "ai-qa-workers", login: "wizard start", body: startBody }));
    const advanceDeadline = Date.now() + 45000;
    let decorationReached = false;
    while (Date.now() < advanceDeadline && !decorationReached) {
      const bodyText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 400)).catch(() => "");
      if (/view summary/i.test(bodyText ?? "")) {
        const previous = page.getByRole("button", { name: /previous/i }).first();
        if (await previous.isVisible().catch(() => false)) { await previous.click({ timeout: 5000 }).catch(() => undefined); }
        else { await page.getByText(new RegExp("previous", "i")).first().click({ timeout: 5000 }).catch(() => undefined); }
        console.info(JSON.stringify({ service: "ai-qa-workers", login: "overshot - stepping back", body: (bodyText ?? "").slice(0, 80) }));
        await page.waitForTimeout(2000);
        continue;
      }
      decorationReached = await clickExact("HYPR TWILL");
      if (!decorationReached) {
        const next = page.getByRole("button", { name: "Next" }).first();
        if (await next.isVisible().catch(() => false)) { await next.click({ timeout: 5000 }).catch(() => undefined); await page.waitForTimeout(1800); }
        else { await page.waitForTimeout(1200); }
      }
    }
    if (!decorationReached) {
      const bodyText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 200)).catch(() => "");
      console.warn(JSON.stringify({ service: "ai-qa-workers", login: "decoration panel never appeared", body: bodyText }));
      return;
    }
    // DECORATION panel: pick location, then CUSTOM
    await clickExact("Right Sleeve");
    await clickExact("Custom");
    // Login modal appears here for logged-out users - fill and submit
    const deadline = Date.now() + 20000;
    while (!(await passwordVisible()) && Date.now() < deadline) { await page.waitForTimeout(1000).catch(() => undefined); }
    if (await passwordVisible()) {
      await page.getByRole("textbox", { name: "USER ID | EMAIL" }).first().fill(credentials.username, { timeout: stepTimeoutMs * 2 });
      // The app validates the email on blur - Tab is required before login submits.
      await page.getByRole("textbox", { name: "USER ID | EMAIL" }).first().press("Tab");
      // The account list loads async after the email blur - wait for the dropdown.
      await waitForAccountList(page, 12000);
      await passwordInput.fill(credentials.password, { timeout: stepTimeoutMs * 2 });
      await page.getByRole("button", { name: "Login" }).first().click({ timeout: stepTimeoutMs * 2 });
      await page.waitForTimeout(3000);
      console.info(JSON.stringify({ service: "ai-qa-workers", login: "session established in plan context" }));
    } else {
      const bodyText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 150)).catch(() => "");
      console.warn(JSON.stringify({ service: "ai-qa-workers", login: "modal never appeared", body: bodyText }));
    }
  };

  // Two attempts: the site is slow and a first pass can land mid-render.
  try {
    await attempt();
  } catch (firstError) {
    console.warn(JSON.stringify({ service: "ai-qa-workers", login: "first attempt failed - retrying", error: firstError instanceof Error ? firstError.message.slice(0, 120) : String(firstError) }));
    try {
      await attempt();
    } catch (secondError) {
      console.warn(JSON.stringify({ service: "ai-qa-workers", login: "failed", error: secondError instanceof Error ? secondError.message.slice(0, 160) : String(secondError) }));
    }
  }
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

interface StepMeta { planId: string; testCaseId: string; frames: Map<string, Buffer>; vars: Map<string, string> }

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
  // Reference comparisons need the stronger vision model; single-image gates
  // (presence checks) are easy and run on the cheap default model.
  const cheapModel = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const compareModel = process.env.VISION_MODEL ?? cheapModel;
  if (reference) {
    const { crops, changedRatio } = await zoomToChange(reference, buffer);
    if (changedRatio < 0.0002) {
      throw new Error("Visual check failed: no visual change detected between the reference frame and the current state (the two captures are pixel-identical), so the expected transformation did not render.");
    }
    let verdict: { pass: boolean; reason: string };
    const images = crops ?? [reference, buffer];
    try {
      verdict = await judgeScreenshot(images, step.target, compareModel);
    } catch {
      verdict = await judgeScreenshot(images, step.target, compareModel).catch((secondError) => {
        throw new Error(`AI visual check could not run: ${secondError instanceof Error ? secondError.message : String(secondError)}`.slice(0, 300));
      });
    }
    if (meta) {
      try {
        await createArtifact(meta.planId, meta.testCaseId, "SCREENSHOT", `${meta.testCaseId}-visual-${Date.now()}.png`, buffer, "image/png");
      } catch { /* evidence is best-effort; never fail the step for it */ }
    }
    if (!verdict.pass) throw new Error(`Visual check failed: ${verdict.reason}`);
    return;
  }
  let verdict: { pass: boolean; reason: string };
  try {
    verdict = await judgeScreenshot([buffer], step.target, cheapModel);
  } catch {
    verdict = await judgeScreenshot([buffer], step.target, cheapModel).catch((secondError) => {
      throw new Error(`AI visual check could not run: ${secondError instanceof Error ? secondError.message : String(secondError)}`.slice(0, 300));
    });
  }
  if (meta) {
    // Evidence: store exactly the image the model judged so users can audit the verdict.
    try {
      await createArtifact(meta.planId, meta.testCaseId, "SCREENSHOT", `${meta.testCaseId}-visual-${Date.now()}.png`, buffer, "image/png");
    } catch { /* evidence is best-effort; never fail the step for it */ }
  }
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
  if (meta) {
    meta.frames.set(name, buffer);
    try {
      await createArtifact(meta.planId, meta.testCaseId, "SCREENSHOT", `${meta.testCaseId}-frame-${name.replace(/[^a-zA-Z0-9-]+/g, "-")}-${Date.now()}.png`, buffer, "image/png");
    } catch { /* evidence is best-effort */ }
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

/**
 * Deterministic render check: sample the canvas inside a percent region and verify
 * every sampled point is the expected hex within a per-channel tolerance (lighting
 * shifts rendered colors, so exact equality is physically impossible on 3D output).
 * No AI involved — pure in-page pixel reads and arithmetic.
 */
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
    const judged = (samples.points ?? []).map((p: any) => {
      const { h, s, l } = rgbToHsl(p.sample[0], p.sample[1], p.sample[2]);
      if (expectedHsl.s < 0.12) {
        // Expected is achromatic (white/grey/black): samples must be too, and not wildly bright/dark.
        return { ...p, ok: s < 0.18 && l > 0.12 && l < 0.95, hsl: { h, s, l } };
      }
      const hueOk = hueDistance(h, expectedHsl.h) <= 20;
      const satOk = s >= Math.max(0.18, expectedHsl.s * 0.4);
      return { ...p, ok: hueOk && satOk, hsl: { h, s, l } };
    });
    const bad = judged.filter((p: any) => !p.ok);
    if (bad.length === 0) return;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(2000).catch(() => undefined);
  }
  const judged = (samples.points ?? []).map((p: any) => {
    const { h, s, l } = rgbToHsl(p.sample[0], p.sample[1], p.sample[2]);
    const hueOk = expectedHsl.s < 0.12 ? (s < 0.18 && l > 0.12 && l < 0.95) : (hueDistance(h, expectedHsl.h) <= 20 && s >= Math.max(0.18, expectedHsl.s * 0.4));
    return { ...p, ok: hueOk, hsl: { h, s, l } };
  });
  const bad = judged.filter((p: any) => !p.ok);
  const worst = bad.reduce((a: any, b: any) => (hueDistance(b.hsl.h, expectedHsl.h) > hueDistance(a.hsl.h, expectedHsl.h) ? b : a), bad[0] ?? { sample: [0, 0, 0], hsl: { h: 0, s: 0, l: 0 } });
  if (meta && samples.crop) {
    // Evidence: the exact canvas state the probe kept sampling.
    try {
      await createArtifact(meta.planId, meta.testCaseId, "SCREENSHOT", `${meta.testCaseId}-color-${Date.now()}.jpg`, Buffer.from(samples.crop.split(",")[1], "base64"), "image/jpeg");
    } catch { /* best-effort */ }
  }
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

async function executeStep(page: Page, step: TestStep, baseUrl: string, credentials?: EnvCredentials | null, meta?: StepMeta) {
  // Captured variables ({{name}}) resolve once here, for every action.
  step = { ...step, target: interpolate(step.target, meta), value: interpolate(step.value, meta) };
  const timeout = { timeout: stepTimeoutMs };
  if (step.action === "navigate") {
    // AI-authored tests may use route-relative targets ("/uploads"); resolve
    // them against the run's environment URL before navigating.
    const target = /^https?:\/\//i.test(step.target) ? step.target : new URL(step.target, baseUrl).toString();
    const result = await page.goto(target, { waitUntil: "domcontentloaded", timeout: stepTimeoutMs * 2 });
    // Heavy client-rendered apps render over ~10s — poll until interactive.
    await waitForAppRender(page, 20000, 2).catch(() => undefined);
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
  if (step.action === "capture") {
    // Read a value out of the page (regex with one capture group over the body
    // text) and store it as a variable for later {{name}} interpolation. Polls:
    // async saves often surface their identifiers seconds after the action.
    const variable = (step.value ?? "").trim();
    if (!variable) throw new Error('capture needs a variable name in the value field (e.g. "designNumber")');
    const deadline = Date.now() + 30000;
    let match: RegExpExecArray | null = null;
    while (Date.now() < deadline) {
      const text = await page.evaluate(() => document.body.innerText);
      match = new RegExp(interpolate(step.target, meta), "i").exec(text);
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
      () => page.getByRole("button", { name: step.target, exact: true }).first().click({ timeout: stageTimeout }),
      () => page.getByRole("link", { name: step.target, exact: true }).first().click({ timeout: stageTimeout }),
      () => page.getByText(step.target, { exact: true }).first().click({ timeout: stageTimeout }),
      () => page.getByText(new RegExp("^" + step.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i")).first().click({ timeout: stageTimeout }),
      () => page.getByText(new RegExp(step.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).first().click({ timeout: stageTimeout }),
      ...(trimmed && trimmed !== step.target ? [() => page.getByText(new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).first().click({ timeout: stageTimeout })] : [])
    ];
    let lastError: unknown;
    for (const stage of stages) {
      try {
        return await stage();
      } catch (error) {
        lastError = error;
      }
    }
    // Nothing matched: fail with what IS on the page so the run is self-diagnosing.
    const visible = await page.evaluate(() => {
      const clean = (value: string) => value.replace(/\s+/g, " ").trim();
      const found: string[] = [];
      for (const el of Array.from(document.querySelectorAll("button, a, [role=button]"))) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const label = clean(el.textContent || "");
        if (label && label.length <= 40 && !found.includes(label)) found.push(label);
      }
      return found.slice(0, 12);
    }).catch(() => [] as string[]);
    // All stages missed: the app may still be rendering — re-wait and retry the
    // whole chain once, including a text-node based click (finds controls whose
    // text sits inside non-leaf elements, e.g. icon + label cards).
    const rendered = await waitForAppRender(page, 12000, 3).catch(() => false);
    if (rendered) {
      for (const stage of stages) {
        try { return await stage(); } catch (retryError) { lastError = retryError; }
      }
    }
    if (await treeTextClick(page, step.target, 8000)) return;
    const lastMessage = lastError instanceof Error ? ` Last stage error: ${lastError.message.split("\n")[0]}` : "";
    throw new Error(`No clickable element matching "${step.target}". Visible buttons/links on the page: ${visible.length ? visible.join(" | ") : "(none)"}.${lastMessage}`);
  }
  if (step.action === "fill") {
    if (step.target.startsWith("css:")) return page.locator(step.target.slice(4)).first().fill(step.value ?? "", timeout);
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
      // Apps like the customizer validate the email on blur - Tab after the
      // username so the field registers before the password/login steps.
      if (isUser) { await page.keyboard.press("Tab").catch(() => undefined); await waitForAccountList(page, 12000); }
      return;
    }
    if (step.value === "__PROOFLINE_USER__" || step.value === "__PROOFLINE_PASS__") {
      const secret = step.value === "__PROOFLINE_USER__" ? credentials?.username ?? "" : credentials?.password ?? "";
      const byLabel = page.getByLabel(step.target).first();
      if (await byLabel.count()) return byLabel.fill(secret, timeout);
      return page.locator('input:not([type="password"]):visible').first().fill(secret, timeout);
    }
    return page.getByLabel(step.target).first().fill(step.value ?? "", timeout);
  }
  if (step.action === "select") {
    // "Select X" usually means choosing a visible option (card, tile, list item),
    // not necessarily an HTML dropdown. Try click-style first, dropdown second.
    const escapedTarget = step.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Token stages: app spellings often differ ("HYPR" vs "Hyper") — match any
    // significant word of the target case-insensitively.
    const significantWords = step.target.split(/\s+/).map((w) => w.replace(/[^a-zA-Z0-9]/g, "")).filter((w) => w.length >= 4);
    const choiceStages = [
      () => page.getByText(step.target, { exact: true }).first().click({ timeout: 3000 }),
      () => page.getByText(new RegExp("^" + escapedTarget + "$", "i")).first().click({ timeout: 3000 }),
      () => page.getByText(new RegExp(escapedTarget, "i")).first().click({ timeout: 3000 }),
      () => page.getByRole("option", { name: step.target }).first().click({ timeout: 3000 }),
      ...significantWords.map((word) => () => page.getByText(new RegExp(word, "i")).first().click({ timeout: 2500 })),
      () => page.getByLabel(step.target).first().selectOption(step.value ?? "", timeout)
    ];
    for (const stage of choiceStages) {
      try { return await stage(); } catch { /* next strategy */ }
    }
    if (await treeTextClick(page, step.target, 8000)) return;
    throw new Error(`Nothing selectable matching "${step.target}". Visible buttons/links: ${await page.evaluate(() => Array.from(document.querySelectorAll("button, a, [role=button], option")).map(el => (el.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 12).join(" | "))}`);
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
  if (step.action === "waitFor") return page.getByText(step.target).first().waitFor({ state: "visible", timeout: stepTimeoutMs });
  if (step.action === "assert") {
    if (step.condition === "visual") return assertVisual(page, step, meta);
    if (step.condition === "hidden") return page.getByText(step.target).first().waitFor({ state: "hidden", timeout: stepTimeoutMs });
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
    if (step.condition === "contains") {
      const actual = await page.textContent("body");
      if (!actual?.includes(step.target)) throw new Error(`Expected page to contain "${step.target}"`);
      return;
    }
    return page.getByText(step.target).first().waitFor({ state: "visible", timeout: stepTimeoutMs });
  }
  throw new Error(`Unsupported test step: ${step.action}`);
}

interface StepOutcome { index: number; action: string; target: string; status: "PASSED" | "FAILED"; error?: string; durationMs: number }

async function runTestCase(context: any, definition: TestDefinition, planId: string, testCaseId: string, baseUrl: string, credentials?: EnvCredentials | null): Promise<{ status: "PASSED" | "FAILED"; error?: string; steps: StepOutcome[]; screenshotBuffer?: Buffer }> {
  const page = await context.newPage();
  const steps: StepOutcome[] = [];
  const frames = new Map<string, Buffer>();
  const vars = new Map<string, string>();
  let screenshotBuffer: Buffer | undefined;
  try {
    for (const [index, step] of definition.steps.entries()) {
      const startedAt = Date.now();
      try {
        await executeStep(page, step, baseUrl, credentials, { planId, testCaseId, frames, vars });
        steps.push({ index, action: step.action, target: step.target, status: "PASSED", durationMs: Date.now() - startedAt });
      } catch (error) {
        steps.push({ index, action: step.action, target: step.target, status: "FAILED", error: error instanceof Error ? error.message : "Unknown step failure", durationMs: Date.now() - startedAt });
        const planDir = join(artifactDir, planId);
        mkdirSync(planDir, { recursive: true });
        screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => undefined);
        return { status: "FAILED", error: `Step ${index + 1} (${step.action} "${step.target}") failed: ${steps[steps.length - 1]!.error}`, steps, screenshotBuffer };
      }
    }
    return { status: "PASSED", steps };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function processPlan(planId: string) {
  const plan = await prisma.executionPlan.findFirst({
    where: { id: planId },
    include: { items: { include: { testCase: true } }, project: true }
  });
  if (!plan) return;
  if (plan.status !== "QUEUED") return;

  const subscription = await prisma.subscription.findUnique({ where: { organizationId: plan.organizationId } });
  if (subscription && ["INCOMPLETE", "BILLING_LOCKED", "CANCELED", "EXPIRED"].includes(subscription.status)) {
    await prisma.executionPlan.update({ where: { id: planId }, data: { status: "BLOCKED", completedAt: new Date() } });
    await prisma.executionPlanItem.updateMany({ where: { executionPlanId: planId, status: "QUEUED" }, data: { status: "BLOCKED", errorMessage: "Billing is locked" } });
    return;
  }

  await prisma.executionPlan.update({ where: { id: planId }, data: { status: "RUNNING", startedAt: new Date() } });

  const credentials = await loadCredentials(plan.projectId, plan.environmentUrl);
  // One browser + context for the whole plan: the login (and its indexedDB /
  // localStorage auth state) persists for every test page in this context.
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (credentials) {
    console.info(JSON.stringify({ service: "ai-qa-workers", login: "credentials found — logging in once in the plan context" }));
    const scratch = await context.newPage();
    await loginOnce(scratch, credentials, plan.environmentUrl);
    await scratch.close();
  }
  let passed = 0;
  let failed = 0;

  for (const item of plan.items) {
    const definition = item.testCase.definition as unknown as TestDefinition | null;
    if (item.status !== "QUEUED") continue;
    if (!definition?.steps?.length) {
      await prisma.executionPlanItem.update({ where: { executionPlanId_testCaseId: { executionPlanId: planId, testCaseId: item.testCaseId } }, data: { status: "SKIPPED", errorMessage: "The test has no executable steps", startedAt: new Date(), finishedAt: new Date() } });
      continue;
    }
    const startedAt = new Date();
    await prisma.executionPlanItem.update({ where: { executionPlanId_testCaseId: { executionPlanId: planId, testCaseId: item.testCaseId } }, data: { status: "RUNNING", startedAt } });
    const runnable = substituteVariables(definition, credentials);
    const result = await runTestCase(context, runnable, planId, item.testCaseId, plan.environmentUrl, credentials);
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

  await prisma.executionPlan.update({
    where: { id: planId },
    data: { status: failed > 0 ? "FAILED" : "PASSED", completedAt: new Date() }
  });
  await browser.close().catch(() => undefined);
  console.info(JSON.stringify({ service: "ai-qa-workers", planId, passed, failed }));
}

async function main() {
  mkdirSync(artifactDir, { recursive: true });
  const runner = new Worker(
    "executions",
    async (job) => processPlan(job.data.planId as string),
    { connection, concurrency }
  );
  const scheduler = new Queue("executions", { connection });
  await scheduler.waitUntilReady();
  console.info(JSON.stringify({ service: "ai-qa-workers", status: "ready", queue: "executions", concurrency }));

  const shutdown = async () => {
    await runner.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error) => {
  console.error(JSON.stringify({ service: "ai-qa-workers", error: error instanceof Error ? error.message : error }));
  process.exitCode = 1;
});
