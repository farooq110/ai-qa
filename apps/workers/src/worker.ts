import { Worker, Queue } from "bullmq";
import IORedis from "ioredis";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { chromium, type Page } from "playwright";
import type { TestDefinition, TestStep } from "@ai-qa/test-dsl";

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6380", { maxRetriesPerRequest: null });
const prisma = new PrismaClient();
const artifactDir = process.env.ARTIFACT_DIR ?? join(process.cwd(), "artifacts");
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

interface StepMeta { planId: string; testCaseId: string; frames: Map<string, Buffer> }

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

/** One vision call: judge the LAST image against the expectation, with any earlier images as REFERENCE frames. */
async function judgeScreenshot(images: Buffer[], expectation: string): Promise<{ pass: boolean; reason: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("AI visual check needs OPENAI_API_KEY configured");
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
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
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
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
  const images = reference ? [reference, buffer] : [buffer];
  let verdict: { pass: boolean; reason: string };
  try {
    verdict = await judgeScreenshot(images, step.target);
  } catch {
    verdict = await judgeScreenshot(images, step.target).catch((secondError) => {
      throw new Error(`AI visual check could not run: ${secondError instanceof Error ? secondError.message : String(secondError)}`.slice(0, 300));
    });
  }
  if (meta) {
    // Evidence: store exactly the image the model judged so users can audit the verdict.
    try {
      const rel = join(meta.planId, `${meta.testCaseId}-visual-${Date.now()}.png`);
      mkdirSync(join(artifactDir, meta.planId), { recursive: true });
      writeFileSync(join(artifactDir, rel), buffer);
      await prisma.artifact.create({ data: { executionPlanId: meta.planId, testCaseId: meta.testCaseId, kind: "SCREENSHOT", path: rel, contentType: "image/png" } });
    } catch { /* evidence is best-effort; never fail the step for it */ }
  }
  if (!verdict.pass) throw new Error(`Visual check failed: ${verdict.reason}`);
}

/** Mid-run named frame: capture the canvas so a later visual assert can compare against it. */
async function captureFrame(page: Page, step: TestStep, meta?: StepMeta): Promise<void> {
  const name = step.target.trim() || `frame-${Date.now()}`;
  const buffer = await captureCanvasShot(page);
  if (meta) {
    meta.frames.set(name, buffer);
    try {
      const rel = join(meta.planId, `${meta.testCaseId}-frame-${name.replace(/[^a-zA-Z0-9-]+/g, "-")}-${Date.now()}.png`);
      mkdirSync(join(artifactDir, meta.planId), { recursive: true });
      writeFileSync(join(artifactDir, rel), buffer);
      await prisma.artifact.create({ data: { executionPlanId: meta.planId, testCaseId: meta.testCaseId, kind: "SCREENSHOT", path: rel, contentType: "image/png" } });
    } catch { /* evidence is best-effort */ }
  }
}

async function executeStep(page: Page, step: TestStep, baseUrl: string, credentials?: EnvCredentials | null, meta?: StepMeta) {
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

async function runTestCase(context: any, definition: TestDefinition, planId: string, testCaseId: string, baseUrl: string, credentials?: EnvCredentials | null): Promise<{ status: "PASSED" | "FAILED"; error?: string; steps: StepOutcome[]; screenshotPath?: string }> {
  const page = await context.newPage();
  const steps: StepOutcome[] = [];
  const frames = new Map<string, Buffer>();
  let screenshotPath: string | undefined;
  try {
    for (const [index, step] of definition.steps.entries()) {
      const startedAt = Date.now();
      try {
        await executeStep(page, step, baseUrl, credentials, { planId, testCaseId, frames });
        steps.push({ index, action: step.action, target: step.target, status: "PASSED", durationMs: Date.now() - startedAt });
      } catch (error) {
        steps.push({ index, action: step.action, target: step.target, status: "FAILED", error: error instanceof Error ? error.message : "Unknown step failure", durationMs: Date.now() - startedAt });
        const planDir = join(artifactDir, planId);
        mkdirSync(planDir, { recursive: true });
        screenshotPath = join(planId, `${testCaseId}-step-${index + 1}.png`);
        try { await page.screenshot({ path: join(artifactDir, screenshotPath), fullPage: true }); } catch { /* page may be unusable */ }
        return { status: "FAILED", error: `Step ${index + 1} (${step.action} "${step.target}") failed: ${steps[steps.length - 1]!.error}`, steps, screenshotPath };
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
  if (subscription && ["BILLING_LOCKED", "CANCELED", "EXPIRED"].includes(subscription.status)) {
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
    if (result.screenshotPath) {
      await prisma.artifact.create({ data: { executionPlanId: planId, testCaseId: item.testCaseId, kind: "SCREENSHOT", path: result.screenshotPath, contentType: "image/png" } });
    }
    const logPath = join(planId, `${item.testCaseId}-steps.json`);
    mkdirSync(join(artifactDir, planId), { recursive: true });
    writeFileSync(join(artifactDir, logPath), JSON.stringify({ title: item.testCase.title, result }, null, 2));
    await prisma.artifact.create({ data: { executionPlanId: planId, testCaseId: item.testCaseId, kind: "LOG", path: logPath, contentType: "application/json" } });
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
