/**
 * Live-app discovery: crawls the deployed application with Playwright to
 * capture the REAL user-facing surface — actual pages, nav items, buttons,
 * and inputs — so generated tests are grounded in verified selectors instead
 * of hallucinated ones.
 *
 * Protected apps: when the environment has credentials the crawler logs in first
 * and reuses that session. A page that still shows a login screen (redirect,
 * password field, popup) is marked `authGated` and never used as the page's
 * controls. Routes that need parameters are crawled with the environment's
 * fixture values and compared against the bare route to prove the values work.
 */
import { chromium, type Page, type Response } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { diffTextSnapshots, firstFixtures, isAuthRoute, isNoiseText, installHostLimiter, sessionKeeper, type LoginCredentials, type SessionStore } from "@ai-qa/test-dsl";
import { decryptField } from "../common/crypto.util";
import { MAX_RESPONSE_BYTES, summarizeResponse, type ResponseShape } from "./response-shape";

export interface DiscoveredPage {
  /** URL actually requested (fixture values included). */
  url: string;
  /** Route pattern from the router, e.g. /customiser or /shop/:id. */
  route: string;
  title: string;
  navItems: string[];
  buttons: string[];
  inputs: string[];
  headings: string[];
  /** All interactive-looking elements (incl. styled divs/spans like stepper labels). */
  clickables: string[];
  /** select dropdowns with their option labels. */
  selects: Array<{ name: string; options: string[] }>;
  /** label text paired with each input where detectable. */
  labelPairs: Array<{ input: string; label: string }>;
  /** First 600 chars of visible page text. */
  pageText: string;
  /** Short texts of the page's own elements (outside the navigation chrome), at most 80: what the page is matched to its source file by. */
  texts?: string[];
  /** Relative path of a page screenshot, when artifact storage is available. */
  screenshotPath?: string;
  /** The page showed a login screen instead of its own content; controls are not trustworthy. */
  authGated?: boolean;
  /** The app sent the browser to another path (e.g. /login -> / when logged in); controls belong to that other page. */
  redirectedTo?: string;
  /** Fixture values used to open the page. */
  paramsUsed?: Record<string, string>;
  /** Page with the values differs from the bare route (so the values really drive it). */
  paramsVerified?: boolean;
  /** List responses the page fetched, keyed "GET /path": field names, enum values, two redacted rows. */
  apiShapes?: Record<string, ResponseShape>;
  /** What exercising a safe filter/search control actually did: real values, real outcomes, not guessed. */
  controlBehaviors?: ControlBehavior[];
  /** page.ariaSnapshot({mode:"ai"}) at capture time, capped at 8k chars: what the generator reads to name a real, accessible target for a spec-grounded test, the same format verify.ts captures at failure. */
  aria?: string;
}

export interface ControlBehavior {
  control: { kind: "select" | "input" | "tab"; label: string };
  valueTried: string;
  /** "GET /api/orders" style, deduped, from calls made while this control's change was settling. */
  requestsFired: string[];
  /** The shape of the LAST matching response, if any - the filtered data, not the page's unfiltered one. */
  responseShape?: ResponseShape;
  /** Path of the call responseShape came from ("/api/orders"); requestsFired may list others. */
  responseCall?: string;
  /** Text on the page both before and after that still matches the value tried: what a filter KEPT. */
  kept?: string[];
  /** Text that appeared / disappeared on the page after the value was applied. */
  appeared: string[];
  disappeared: string[];
  urlChanged?: string;
  /** Observed with this other control already applied; appeared/disappeared are relative to that state. */
  after?: { control: { kind: "select" | "input" | "tab"; label: string }; valueTried: string };
}

export interface DiscoveryResult {
  pages: DiscoveredPage[];
  /** Login failed because the app rate-limited it (HTTP 429). */
  loginRateLimited?: boolean;
  /** none: no credentials configured. */
  login: "none" | "ok" | "failed";
  error?: string;
}

export interface DiscoveryAuth {
  credentials?: LoginCredentials;
  /** route pattern -> { parameter: value } */
  fixtures?: Record<string, Record<string, string>>;
}

/** Credentials + fixtures from an EnvironmentProfile row (secrets decrypted here, never returned to clients). */
export function discoveryAuth(environment: {
  usernameEnc: string | null; usernameIv: string | null; usernameTag: string | null;
  passwordEnc: string | null; passwordIv: string | null; passwordTag: string | null;
  loginUrl: string | null; loginTriggerSelector: string | null;
  usernameSelector: string | null; passwordSelector: string | null; submitSelector: string | null;
  routeFixtures: unknown;
}): DiscoveryAuth {
  const secret = process.env.JWT_SECRET ?? "";
  // Several sets for a route (one per 3D model, say): the crawl reads the page with the first.
  const auth: DiscoveryAuth = { fixtures: firstFixtures(environment.routeFixtures) };
  if (environment.usernameEnc && environment.usernameIv && environment.usernameTag && environment.passwordEnc && environment.passwordIv && environment.passwordTag) {
    try {
      auth.credentials = {
        username: decryptField({ enc: environment.usernameEnc, iv: environment.usernameIv, tag: environment.usernameTag }, secret),
        password: decryptField({ enc: environment.passwordEnc, iv: environment.passwordIv, tag: environment.passwordTag }, secret),
        loginUrl: environment.loginUrl, loginTrigger: environment.loginTriggerSelector,
        usernameSelector: environment.usernameSelector, passwordSelector: environment.passwordSelector, submitSelector: environment.submitSelector
      };
    } catch { /* undecryptable credentials behave as "none" */ }
  }
  return auth;
}

/** `/shop/:id` + { id: "7", color: "red" } -> `/shop/7?color=red`. Unknown `:name` stays as is. */
export function routeWithValues(route: string, values: Record<string, string>): string {
  const rest = { ...values };
  const path = route.replace(/:([A-Za-z_]\w*)/g, (whole, name: string) => {
    if (!(name in rest)) return whole;
    const value = rest[name];
    delete rest[name];
    return encodeURIComponent(value);
  });
  const query = new URLSearchParams(rest).toString();
  return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
}

export const NAV_TIMEOUT_MS = 20_000;
export const SETTLE_MS = 1_500;
const MAX_PAGES = 10;
export const LOGIN_ROUTE = /log-?in|sign-?in|sign-?on|auth|sso/i;

/** Everything the model may reference on the page, read after the app settled. */
export async function readPage(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    // Shared layout chrome (sidebar/header nav search, etc.) is not this page's own feature -
    // navItems deliberately includes it, inputs/labelPairs/clickables must not, or every page
    // "has" the global nav search as if it were a page-specific control.
    const ownContent = (el: Element) => visible(el) && !el.closest('nav, aside, header, [role="navigation"], [role="banner"]');
    const clean = (value: string) => value.replace(/\s+/g, " ").trim();
    const texts = (selector: string, limit: number, within: (el: Element) => boolean = visible) =>
      Array.from(document.querySelectorAll(selector))
        .filter(within)
        .map((el) => clean(el.textContent || el.getAttribute("aria-label") || ""))
        .filter((value) => value && value.length <= 60)
        .filter((value, index, all) => all.indexOf(value) === index)
        .slice(0, limit);
    const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
      .filter(ownContent)
      .map((el) => {
        const field = el as HTMLInputElement;
        return clean(field.placeholder || field.getAttribute("aria-label") || field.getAttribute("name") || field.type || "");
      })
      .filter(Boolean)
      .slice(0, 15);
    // label<->input pairs: label[for=id] or wrapping label
    const labelPairs = Array.from(document.querySelectorAll("input, textarea, select"))
      .filter(ownContent)
      .map((el) => {
        const field = el as HTMLInputElement;
        const byFor = field.id ? document.querySelector(`label[for="${field.id}"]`) : null;
        const wrap = field.closest("label");
        const label = clean((byFor ?? wrap)?.textContent || field.placeholder || field.getAttribute("aria-label") || "");
        return { input: clean(field.placeholder || field.getAttribute("aria-label") || field.name || field.type || ""), label };
      })
      .filter((pair) => pair.input || pair.label)
      .slice(0, 15);
    // clickables: explicit controls + heuristic (cursor:pointer, role, tabindex)
    const clickables: string[] = [];
    const seenClick = new Set<string>();
    for (const el of Array.from(document.querySelectorAll("button, a, [role=button], [onclick], [tabindex], select, input[type=submit], input[type=button], label"))) {
      if (!ownContent(el)) continue;
      const text = clean(el.textContent || el.getAttribute("aria-label") || "");
      if (!text || text.length > 60) continue;
      const key = text.toLowerCase();
      if (seenClick.has(key)) continue;
      seenClick.add(key);
      clickables.push(text);
      if (clickables.length >= 25) break;
    }
    for (const el of Array.from(document.querySelectorAll("div, span, li, td"))) {
      if (clickables.length >= 25) break;
      if (!ownContent(el)) continue;
      if ((el as HTMLElement).style.cursor !== "pointer") continue;
      if (el.querySelector("button, a")) continue;
      const text = clean(el.textContent || "");
      if (!text || text.length > 60) continue;
      const key = text.toLowerCase();
      if (seenClick.has(key)) continue;
      seenClick.add(key);
      clickables.push(text);
    }
    const selects = Array.from(document.querySelectorAll("select"))
      .filter(ownContent)
      .map((sel) => ({
        name: clean(sel.getAttribute("aria-label") || sel.getAttribute("name") || ""),
        options: Array.from((sel as HTMLSelectElement).options).map((option) => clean(option.textContent || "")).filter(Boolean).slice(0, 10)
      }))
      .slice(0, 8);
    // Every short text the page itself shows (table headers, field captions, messages): the phrases a
    // page is later matched to its source file by. Leaf elements only, outside the navigation chrome.
    const ownText: string[] = [];
    const seenText = new Set<string>();
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (ownText.length >= 80) break;
      if (el.children.length || !ownContent(el) || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName)) continue;
      const text = clean(el.textContent || "");
      if (text.length < 3 || text.length > 60 || seenText.has(text.toLowerCase())) continue;
      seenText.add(text.toLowerCase());
      ownText.push(text);
    }
    return {
      title: clean(document.title),
      texts: ownText,
      navItems: texts("nav a, header a, aside a, [role=navigation] a", 15),
      buttons: texts("button, [role=button], a.btn", 20, ownContent),
      inputs,
      headings: texts("h1, h2, h3", 8),
      clickables,
      selects,
      labelPairs,
      pageText: clean(document.body.innerText).slice(0, 600),
      hasPassword: Array.from(document.querySelectorAll('input[type="password"]')).some(visible),
      hasDialog: Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).some(visible)
    };
  });
}

export interface SafeControl {
  /** Set as `data-safe-idx` on the element, so a caller can `locate()` it after this read-only scan. */
  idx: number;
  kind: "select" | "input" | "tab";
  label: string;
  /** For a select: one option worth trying (not the current one), picked here so step 2 just applies it. */
  optionLabel?: string;
  optionValue?: string;
}

/** Labels that suggest a mutating action: reused verb list from the crawler's nav-click safety (crawler.ts DENY_CLICK). */
// Whole words only: "Approved"/"Cancelled" are status filters, "Payroll" is a page - "Approve"/"Cancel"/"Pay" are the actions.
const DENY_CONTROL = /\b(delete|remove|archive|logout|log ?out|sign ?out|signout|cancel|deactivate|disable|enable|reset|clear|pay|approve|reject|send|submit|save|create|add|new|import|export|download|upload|confirm|publish|discard|revoke|unsubscribe)\b/i;

/**
 * Read-only filter/search controls safe to exercise: a `<select>` or a text-ish `<input>`, never
 * inside a `<form>` (so nothing can ever submit), never matching a mutating-looking label. Marks
 * each with `data-safe-idx`; this function only looks, it never sets a value or fires an event.
 */
export async function listSafeControls(page: Page, limit = 6): Promise<SafeControl[]> {
  return page.evaluate(({ denySource, limit: cap }) => {
    const deny = new RegExp(denySource, "i");
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const clean = (value: string) => value.replace(/\s+/g, " ").trim();
    const labelOf = (el: Element) => {
      const field = el as HTMLInputElement;
      const byFor = field.id ? document.querySelector(`label[for="${field.id}"]`) : null;
      const wrap = field.closest("label");
      return clean((byFor ?? wrap)?.textContent || field.getAttribute("aria-label") || field.placeholder || field.getAttribute("name") || "");
    };
    // A previous scan's markers may sit on elements this scan now skips; a stale index would resolve to the wrong control.
    document.querySelectorAll("[data-safe-idx]").forEach((el) => el.removeAttribute("data-safe-idx"));
    const controls: Array<{ idx: number; kind: "select" | "input" | "tab"; label: string; optionLabel?: string; optionValue?: string }> = [];
    let idx = 0;
    for (const el of Array.from(document.querySelectorAll("select, input"))) {
      if (controls.length >= cap) break;
      if (!visible(el) || el.closest("form")) continue; // a form could submit; never touch anything inside one
      if (el.closest('nav, aside, header, [role="navigation"], [role="banner"]')) continue; // shared chrome, not this page's own feature
      const tag = el.tagName.toLowerCase();
      if (tag === "input") {
        const type = (el as HTMLInputElement).type;
        if (!["text", "search", ""].includes(type)) continue; // never checkbox/radio/file/password/...
      }
      const label = labelOf(el);
      if (!label || deny.test(label)) continue;
      if (tag === "select") {
        const sel = el as HTMLSelectElement;
        const other = Array.from(sel.options).find((option, index) => index !== sel.selectedIndex && option.value && !deny.test(option.textContent || ""));
        if (!other) continue;
        el.setAttribute("data-safe-idx", String(idx));
        controls.push({ idx, kind: "select", label, optionLabel: clean(other.textContent || ""), optionValue: other.value });
      } else {
        el.setAttribute("data-safe-idx", String(idx));
        controls.push({ idx, kind: "input", label });
      }
      idx += 1;
    }
    // Filter chips / segmented tabs: a row of 3+ sibling buttons ("All", "Pending", "Approved") outside forms and
    // app chrome, none of them an action. Skip the first (the default view); one group per page.
    if (controls.length < cap) {
      const parents = new Set<Element>();
      for (const button of Array.from(document.querySelectorAll("button"))) if (button.parentElement) parents.add(button.parentElement);
      for (const parent of parents) {
        if (parent.closest('form, nav, aside, header, [role="navigation"], [role="banner"]')) continue;
        const buttons = Array.from(parent.children).filter((child) => child.tagName === "BUTTON" && visible(child));
        if (buttons.length < 3 || buttons.length > 12) continue;
        const labels = buttons.map((button) => clean(button.textContent || ""));
        if (labels.some((text) => !text || text.length > 30 || deny.test(text))) continue;
        for (const [at, button] of buttons.entries()) {
          if (at === 0 || at > 2 || controls.length >= cap) continue;
          const label = labels[at].replace(/\d+$/, "").trim(); // the trailing count changes with the data
          if (!label) continue;
          button.setAttribute("data-safe-idx", String(idx));
          controls.push({ idx, kind: "tab", label });
          idx += 1;
        }
        break;
      }
    }
    return controls;
  }, { denySource: DENY_CONTROL.source, limit });
}

/**
 * Every short, visible leaf text on the page (table cells, rows, headings, buttons, links) - broader
 * and more granular than readPage's curated lists, because exerciseControls needs to see a single
 * row disappear ("North Region" gone from the table), not just whether a button's label changed.
 */
async function collectDiffableTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const clean = (value: string) => value.replace(/\s+/g, " ").trim();
    const leafTags = "td, th, li, tr, h1, h2, h3, h4, button, a, p, label, dt, dd";
    const texts = new Set<string>();
    for (const el of Array.from(document.querySelectorAll(`${leafTags}, span, div`))) {
      if (texts.size >= 300) break;
      if (!visible(el) || el.querySelector(leafTags)) continue; // a container whose own children will be captured
      const text = clean(el.textContent || "");
      if (text && text.length <= 80) texts.add(text);
    }
    return [...texts];
  });
}

// 2+ chars: many apps gate search on a minimum length (seen here: "Type at least 2 characters."),
// so a 1-char probe never fires the real filtered request - it only ever observes the validation message.
const PROBE_TEXT = "te";
const CONTROL_SETTLE_MS = 1_500;

/**
 * A nonsense probe like PROBE_TEXT matches nothing on a real, seeded list, so every exercised search
 * input looks identical: "no matches". Prefer an ID-like token (ORD-2026-1, CUST-017) visible on the page
 * right now so the filtered call can genuinely match something - real positive AND negative grounding.
 * Tokens that are a label glued to a count ("All633") or a run-together blob are skipped. Falls back to
 * PROBE_TEXT when no ID is on screen (apps whose rows have no ID-like value only get the negative case).
 */
function pickProbe(texts: string[]): string {
  for (const text of texts) {
    if (isNoiseText(text)) continue;
    const token = text.match(/\b[A-Za-z]{2,8}-[A-Za-z0-9-]*\d[A-Za-z0-9-]*/)?.[0];
    if (token) return token;
  }
  return PROBE_TEXT;
}

// Background calls an app makes on any interaction (session refresh, "who am I"): never what a control did.
const BACKGROUND_CALL = /\/(auth|session|csrf|token|refresh|whoami|health|ping)(\/|$|\?)/i;

// Nothing real contains this: the "matches nothing" case, observed on purpose instead of by accident.
const NEGATIVE_PROBE = "zzqx9";

/**
 * Search terms taken from the page's own first data rows (table or grid cells): ID-like tokens first,
 * then plain words. A term the list really contains is far more likely to match than a made-up one.
 */
export async function rowProbeCandidates(page: Page): Promise<string[]> {
  const tokens = await page.evaluate(() => {
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const found: string[] = [];
    const rows = Array.from(document.querySelectorAll("tbody tr, [role=row]")).filter(visible).slice(0, 3);
    for (const row of rows) {
      for (const cell of Array.from(row.querySelectorAll("td, [role=cell], [role=gridcell]")).filter(visible)) {
        // One element at a time: a cell often holds an ID and a name in sibling spans, and textContent runs them together.
        const leaves = Array.from(cell.querySelectorAll("*")).filter((el) => !el.children.length);
        for (const leaf of leaves.length ? leaves : [cell]) {
          const text = (leaf.textContent || "").replace(/\s+/g, " ").trim();
          if (text && text.length <= 80) found.push(...(text.match(/[A-Za-z0-9][A-Za-z0-9._-]{3,}/g) ?? []));
        }
      }
    }
    return found.slice(0, 60);
  });
  const usable = [...new Set(tokens)].filter((token) => !isNoiseText(token) && !/^\d+$/.test(token));
  const rank = (token: string) => (/-/.test(token) && /\d/.test(token) ? 0 : /\d/.test(token) && /[A-Za-z]/.test(token) ? 1 : 2);
  return usable.sort((a, b) => rank(a) - rank(b)).slice(0, 3);
}

/** Apply one value to one control and watch what it causes. Null when the control could not be driven. */
async function observeControl(page: Page, baseUrl: string, control: SafeControl, probeOverride?: string): Promise<Omit<ControlBehavior, "after"> | null> {
  const isTrackedCall = (resourceType: string, url: URL) =>
    ["fetch", "xhr"].includes(resourceType) && (url.origin === new URL(baseUrl).origin || /api/i.test(url.hostname + url.pathname));
  const beforeUrl = page.url();
  const beforeTexts = await collectDiffableTexts(page);
  const captured: Array<{ method: string; url: string; json: unknown }> = [];
  const onResponse = (response: Response) => {
    const request = response.request();
    const url = new URL(request.url());
    if (request.method() !== "GET" || response.status() !== 200 || !isTrackedCall(request.resourceType(), url)) return;
    if (!(response.headers()["content-type"] ?? "").includes("json") || BACKGROUND_CALL.test(url.pathname)) return;
    void Promise.race([
      response.body(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("response.body() timed out")), 5_000))
    ]).then((body) => { if (body.length <= MAX_RESPONSE_BYTES) captured.push({ method: request.method(), url: request.url(), json: JSON.parse(body.toString("utf8")) }); })
      .catch(() => undefined);
  };
  page.on("response", onResponse);
  const locator = page.locator(`[data-safe-idx="${control.idx}"]`).first();
  const probe = probeOverride ?? pickProbe(beforeTexts);
  try {
    if (control.kind === "select") await locator.selectOption(control.optionValue ? { value: control.optionValue } : { label: control.optionLabel! }, { timeout: 3_000 });
    else if (control.kind === "tab") await locator.click({ timeout: 3_000 });
    else await locator.fill(probe, { timeout: 3_000 });
    await page.waitForTimeout(CONTROL_SETTLE_MS);
  } catch {
    return null;
  } finally {
    page.off("response", onResponse);
  }
  const afterTexts = await collectDiffableTexts(page);
  const diff = diffTextSnapshots({ texts: beforeTexts, url: beforeUrl }, { texts: afterTexts, url: page.url() });
  const call = captured.at(-1);
  const valueTried = control.kind === "select" ? (control.optionLabel ?? control.optionValue ?? "") : control.kind === "tab" ? control.label : probe;
  const needle = valueTried.toLowerCase();
  const afterSet = new Set(afterTexts.map((text) => text.toLowerCase()));
  // A 1-3 char value ("te") is a substring of unrelated nav text; "kept" is only evidence for a real search term.
  const kept = needle.length >= 4 ? [...new Set(beforeTexts.filter((text) => text.toLowerCase().includes(needle) && afterSet.has(text.toLowerCase()) && !isNoiseText(text)))].slice(0, 8) : [];
  return {
    control: { kind: control.kind, label: control.label },
    valueTried,
    requestsFired: [...new Set(captured.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`))],
    ...(call ? { responseShape: summarizeResponse(call.json) ?? undefined, responseCall: new URL(call.url).pathname } : {}),
    ...(kept.length ? { kept } : {}),
    ...diff
  };
}

const MAX_COMBOS = 3;

/**
 * Exercise up to `limit` of the page's safe controls (see listSafeControls), one at a time: apply a
 * real value, see what request fired and what changed on the page, then reload back to a clean
 * baseline before the next one. Then try up to MAX_COMBOS pairs (a select, then another data-driving
 * control) so generation sees what two filters TOGETHER really do, not each one's solo behavior.
 * Stops starting new work once `until` (epoch ms) has passed.
 */
export async function exerciseControls(page: Page, baseUrl: string, limit = 6, until = Infinity): Promise<ControlBehavior[]> {
  const found = await listSafeControls(page, limit);
  if (!found.length) return [];
  const startUrl = page.url();
  const reset = async () => {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
    await page.waitForTimeout(SETTLE_MS);
  };
  // A reload clears every data-safe-idx marker; re-find a control by kind + label.
  const refind = async (target: { kind: string; label: string }) =>
    (await listSafeControls(page, limit)).find((entry) => entry.kind === target.kind && entry.label === target.label);

  const behaviors: ControlBehavior[] = [];
  const matched = (observed: Omit<ControlBehavior, "after"> | null) => Boolean(observed && (observed.kept?.length || (observed.responseShape?.total ?? 0) > 0));
  let negativeDone = false;
  for (const target of found) {
    if (Date.now() > until) break;
    const current = await refind(target);
    if (!current) continue;
    let observed: Omit<ControlBehavior, "after"> | null;
    if (current.kind === "input") {
      // Try terms from the page's own rows until one really matches (up to 3); that is the positive case.
      const candidates = await rowProbeCandidates(page);
      observed = await observeControl(page, baseUrl, current, candidates[0]);
      for (const candidate of candidates.slice(1)) {
        if (matched(observed) || Date.now() > until) break;
        await reset();
        const again = await refind(target);
        if (!again) break;
        observed = await observeControl(page, baseUrl, again, candidate) ?? observed;
      }
    } else {
      observed = await observeControl(page, baseUrl, current);
    }
    if (observed) behaviors.push(observed);
    // Reload to a clean baseline - simpler and more reliable than reverting arbitrary widget state.
    await reset();
    // One deliberate "matches nothing" run per page, on the first search that did match: the negative case.
    if (current.kind === "input" && !negativeDone && matched(observed) && Date.now() < until) {
      negativeDone = true;
      const again = await refind(target);
      const negative = again ? await observeControl(page, baseUrl, again, NEGATIVE_PROBE) : null;
      if (negative) behaviors.push(negative);
      await reset();
    }
  }

  // Only a control that changed data can interact with another; selects go first (filter, then refine).
  const seenControl = new Set<string>();
  const fired = behaviors.filter((behavior) => behavior.requestsFired.length && !seenControl.has(`${behavior.control.kind}:${behavior.control.label}`) && seenControl.add(`${behavior.control.kind}:${behavior.control.label}`));
  const pairs = fired
    .filter((first) => first.control.kind !== "input")
    // Tabs in one group exclude each other, so a tab is never the second control after another tab.
    .flatMap((first) => fired.filter((second) => second !== first && !(first.control.kind === "tab" && second.control.kind === "tab")).map((second) => ({ first, second })))
    .sort((a, b) => overlap(b.first, b.second) - overlap(a.first, a.second))
    .slice(0, MAX_COMBOS);
  for (const { first, second } of pairs) {
    if (Date.now() > until) break;
    const a = await refind(first.control);
    if (!a || !(await observeControl(page, baseUrl, a))) { await reset(); continue; }
    // The page now holds A's filter; B is observed relative to that state.
    const b = await refind(second.control);
    const combined = b ? await observeControl(page, baseUrl, b) : null;
    if (combined) behaviors.push({ ...combined, after: { control: first.control, valueTried: first.valueTried } });
    await reset();
  }
  return behaviors;
}

/**
 * A control present on nearly every page (a layout-level "Search modules" box) belongs to the app shell,
 * not to each page's own feature. Keep it on the first page that has it and drop it from the rest, so
 * generation never writes an Orders test that drives the global search. Needs enough pages to tell shared
 * from merely common; a "Search" box on 3 of 12 list pages stays.
 */
export function dedupeSharedControls(pages: DiscoveredPage[]): void {
  const real = pages.filter((page) => !page.authGated);
  if (real.length < 4) return;
  const counts = new Map<string, number>();
  const tally = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const page of real) {
    for (const label of new Set(page.inputs)) tally(`input:${label}`);
    for (const label of new Set((page.controlBehaviors ?? []).filter((behavior) => !behavior.after).map((behavior) => `${behavior.control.kind}:${behavior.control.label}`))) tally(label);
  }
  const shared = new Set([...counts].filter(([, count]) => count / real.length >= 0.8).map(([key]) => key));
  if (!shared.size) return;
  const owner = new Map<string, DiscoveredPage>();
  for (const page of real) {
    for (const key of shared) {
      const has = page.inputs.some((label) => `input:${label}` === key) || (page.controlBehaviors ?? []).some((behavior) => `${behavior.control.kind}:${behavior.control.label}` === key);
      if (has && !owner.has(key)) owner.set(key, page);
    }
  }
  for (const page of real) {
    const isShared = (kind: string, label: string) => shared.has(`${kind}:${label}`) && owner.get(`${kind}:${label}`) !== page;
    page.inputs = page.inputs.filter((label) => !isShared("input", label));
    if (page.labelPairs) page.labelPairs = page.labelPairs.filter((pair) => !isShared("input", pair.input));
    if (page.controlBehaviors) {
      page.controlBehaviors = page.controlBehaviors.filter((behavior) => !isShared(behavior.control.kind, behavior.control.label) && !(behavior.after && isShared(behavior.after.control.kind, behavior.after.control.label)));
      if (!page.controlBehaviors.length) delete page.controlBehaviors;
    }
  }
}

const overlap = (a: ControlBehavior, b: ControlBehavior) => a.requestsFired.filter((call) => b.requestsFired.includes(call)).length;

export const strip = ({ signature: _signature, ...entry }: DiscoveredPage & { signature?: string }): DiscoveredPage => entry;

/** Open one URL and read it. Null when the page failed to load. */
/** The whole visible page is one short loading message. */
const STILL_LOADING = /^.{0,60}\b(?:loading|authenticating|please wait|redirecting|checking)\b.{0,30}$/i;
const LOADING_RETRIES = 4;

export async function capturePage(pg: Page, baseUrl: string, route: string, requested: string, values?: Record<string, string>): Promise<(DiscoveredPage & { signature: string }) | null> {
  const url = new URL(requested, baseUrl).toString();
  try {
    await pg.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await pg.waitForTimeout(SETTLE_MS);
    let read = await readPage(pg);
    // A page that only says "Authenticating..." / "Loading..." - or shows nothing to use yet (a heavy app
    // still behind its splash screen: 3D, maps, large bundles) - has not rendered: wait for it rather
    // than recording the spinner as the page.
    const notRendered = (page: typeof read) => STILL_LOADING.test(page.pageText) || !(page.buttons.length || page.inputs.length || page.headings.length || page.clickables.length);
    for (let attempt = 0; attempt < LOADING_RETRIES && notRendered(read); attempt++) {
      await pg.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
      await pg.waitForTimeout(1_500);
      read = await readPage(pg);
    }
    const { hasPassword, hasDialog, ...data } = read;
    const finalPath = new URL(pg.url()).pathname;
    const requestedPath = new URL(url).pathname;
    const redirectedToLogin = finalPath !== requestedPath && LOGIN_ROUTE.test(finalPath) && !LOGIN_ROUTE.test(requestedPath);
    const loginScreen = (hasPassword || (hasDialog && /password|log ?in|sign ?in/i.test(data.pageText))) && !LOGIN_ROUTE.test(requestedPath);
    const authGated = redirectedToLogin || loginScreen;
    const trim = (path: string) => path.replace(/\/+$/, "") || "/";
    const redirectedTo = !authGated && trim(finalPath) !== trim(requestedPath) ? finalPath : undefined;
    const aria = authGated ? undefined : await pg.ariaSnapshot({ mode: "ai" }).then((snapshot: string) => snapshot.slice(0, 8_000)).catch(() => undefined);
    const record: DiscoveredPage & { signature: string } = {
      url, route, ...data, ...(authGated ? { authGated: true } : {}), ...(redirectedTo ? { redirectedTo } : {}), ...(values ? { paramsUsed: values } : {}), ...(aria ? { aria } : {}),
      signature: JSON.stringify([data.title, data.headings, data.buttons, data.clickables, data.inputs, data.pageText.slice(0, 300)])
    };
    try {
      const shotDir = join(process.env.ARTIFACT_DIR ?? "artifacts", "discovery");
      mkdirSync(shotDir, { recursive: true });
      const shotPath = join("discovery", (route.replace(/[^a-z0-9]+/gi, "_") || "root") + ".png");
      await pg.screenshot({ path: join(shotDir, shotPath), fullPage: false });
      record.screenshotPath = shotPath.split(/[\\/]/).join("/");
    } catch { /* screenshots are best-effort */ }
    return record;
  } catch {
    // A page that fails to load is still informative by its absence — skip it.
    return null;
  }
}

export async function discoverLiveApp(
  baseUrl: string,
  extraRoutes: string[],
  options?: { onlyRoutes?: string[]; auth?: DiscoveryAuth; sessionState?: unknown; sessionStore?: SessionStore }
): Promise<DiscoveryResult> {
  let browser;
  const pages: DiscoveredPage[] = [];
  let login: DiscoveryResult["login"] = "none";
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, ...(options?.sessionState ? { storageState: options.sessionState as never } : {}) });
    let rateLimited = false;
    const limiter = await installHostLimiter(context, { onRateLimited: () => { rateLimited = true; } });
    context.on("response", (response) => { if (response.status() === 429) rateLimited = true; });
    const keeper = sessionKeeper(context, { baseUrl, credentials: options?.auth?.credentials, limiter, store: options?.sessionStore });
    login = await keeper.login(Boolean(options?.sessionState));
    const page = await context.newPage();
    const fixtures = options?.auth?.fixtures ?? {};

    const visitedRoutes = new Set<string>();
    let firstTitle = "";

    const capture = async (pg: Page, route: string, requested: string, values?: Record<string, string>) => {
      await limiter.waitUntilReady();
      let record = await capturePage(pg, baseUrl, route, requested, values);
      // Logged in at the start but this page shows the login screen: the session died mid-crawl.
      // Recover it and re-read the page rather than recording every remaining route as "requires login".
      if (record?.authGated && pg === page && login === "ok" && await keeper.recover({ loginScreen: true }) === "restored") {
        record = await capturePage(pg, baseUrl, route, requested, values);
      }
      if (record && !firstTitle && !record.authGated) firstTitle = record.title;
      return record;
    };

    let anonPage: Page | undefined;
    const anonymousPage = async () => {
      if (anonPage) return anonPage;
      const anonContext = await browser!.newContext({ viewport: { width: 1366, height: 900 } });
      await installHostLimiter(anonContext, { onRateLimited: () => { rateLimited = true; } });
      return (anonPage = await anonContext.newPage());
    };

    const visit = async (route: string) => {
      if (visitedRoutes.has(route) || visitedRoutes.size >= MAX_PAGES) return;
      visitedRoutes.add(route);
      const values = fixtures[route];
      const hasValues = Boolean(values && Object.keys(values).length);
      if (route.includes(":") && !hasValues) return; // no real values: cannot open the page
      // A logged-in session is redirected away from /login, /forgot-password...: read those routes logged out.
      const target = isAuthRoute(route) && login === "ok" ? await anonymousPage() : page;
      if (!hasValues) {
        const record = await capture(target, route, route);
        if (record) pages.push(record);
        return;
      }
      // Parameterised page: bare route first (query-only routes), then with values; values must change the page.
      const bare = route.includes(":") ? null : await capture(target, route, route);
      const record = await capture(target, route, routeWithValues(route, values!), values);
      if (!record) return;
      record.paramsVerified = !record.authGated && (bare ? bare.signature !== record.signature : Boolean(record.buttons.length || record.headings.length || record.inputs.length));
      pages.push(record);
    };

    const useful = (entry: DiscoveredPage) => entry.authGated || entry.buttons.length || entry.inputs.length || entry.headings.length || entry.navItems.length || entry.clickables.length;

    if (options?.onlyRoutes?.length) {
      for (const route of options.onlyRoutes.slice(0, MAX_PAGES)) await visit(route);
      await keeper.save();
      return { pages: pages.filter((entry, index) => index === 0 || useful(entry)).map(strip), login };
    }
    await visit("/");
    // Same-origin links found on the entry page + the static route table.
    const foundLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => (anchor as HTMLAnchorElement).href)
        .filter((href) => href.startsWith(window.location.origin))
        .map((href) => new URL(href).pathname)
        .filter((path) => path !== "/" && !path.match(/\.(png|jpe?g|svg|css|js|ico|woff2?)$/i))
    ).catch(() => [] as string[]);
    const candidates = [...new Set([...extraRoutes.filter((route) => route && route !== "*"), ...foundLinks])];
    for (const route of candidates) await visit(route);

    // Keep gated pages (generation reports why they are skipped); drop empty shells.
    const meaningful = pages.filter((entry, index) => index === 0 || useful(entry));
    await keeper.save();
    return { pages: meaningful.map((entry) => ({ ...strip(entry), title: entry.title || firstTitle })), login, ...(rateLimited ? { loginRateLimited: true } : {}) };
  } catch (error) {
    return { pages: pages.map(strip), login, error: error instanceof Error ? error.message : "live discovery failed" };
  } finally {
    try { await browser?.close(); } catch { /* already closed */ }
  }
}
