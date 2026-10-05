/**
 * Live-app discovery: crawls the deployed application with Playwright to
 * capture the REAL user-facing surface — actual pages, nav items, buttons,
 * and inputs — so generated tests are grounded in verified selectors instead
 * of hallucinated ones.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface DiscoveredPage {
  url: string;
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
  /** Relative path of a page screenshot, when artifact storage is available. */
  screenshotPath?: string;
}

export interface DiscoveryResult {
  pages: DiscoveredPage[];
  error?: string;
}

const NAV_TIMEOUT_MS = 20_000;
const SETTLE_MS = 1_500;
const MAX_PAGES = 10;

export async function discoverLiveApp(baseUrl: string, extraRoutes: string[], options?: { onlyRoutes?: string[] }): Promise<DiscoveryResult> {
  let browser;
  const pages: DiscoveredPage[] = [];
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();

    const visitedRoutes = new Set<string>();
    let firstTitle = "";

    const visit = async (route: string) => {
      if (visitedRoutes.has(route) || visitedRoutes.size >= MAX_PAGES) return;
      visitedRoutes.add(route);
      const url = new URL(route, baseUrl).toString();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await page.waitForTimeout(SETTLE_MS);
        const data = await page.evaluate(() => {
          const visible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const clean = (value: string) => value.replace(/\s+/g, " ").trim();
          const texts = (selector: string, limit: number) =>
            Array.from(document.querySelectorAll(selector))
              .filter(visible)
              .map((el) => clean(el.textContent || el.getAttribute("aria-label") || ""))
              .filter((value) => value && value.length <= 60)
              .filter((value, index, all) => all.indexOf(value) === index)
              .slice(0, limit);
          const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
            .filter(visible)
            .map((el) => {
              const field = el as HTMLInputElement;
              return clean(field.placeholder || field.getAttribute("aria-label") || field.getAttribute("name") || field.type || "");
            })
            .filter(Boolean)
            .slice(0, 15);
          // label<->input pairs: label[for=id] or wrapping label
          const labelPairs = Array.from(document.querySelectorAll("input, textarea, select"))
            .filter(visible)
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
            if (!visible(el)) continue;
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
            if (!visible(el)) continue;
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
            .filter(visible)
            .map((sel) => ({
              name: clean(sel.getAttribute("aria-label") || sel.getAttribute("name") || ""),
              options: Array.from((sel as HTMLSelectElement).options).map((option) => clean(option.textContent || "")).filter(Boolean).slice(0, 10)
            }))
            .slice(0, 8);
          return {
            title: clean(document.title),
            navItems: texts("nav a, header a, aside a, [role=navigation] a", 15),
            buttons: texts("button, [role=button], a.btn", 20),
            inputs,
            headings: texts("h1, h2, h3", 8),
            clickables,
            selects,
            labelPairs,
            pageText: clean(document.body.innerText).slice(0, 600)
          };
        }) as { title: string; navItems: string[]; buttons: string[]; inputs: string[]; headings: string[]; clickables: string[]; selects: Array<{ name: string; options: string[] }>; labelPairs: Array<{ input: string; label: string }>; pageText: string };
        if (!firstTitle) firstTitle = data.title;
        const page_: DiscoveredPage & { screenshotPath?: string } = { url, route, ...data };
        try {
          const shotDir = join(process.env.ARTIFACT_DIR ?? "artifacts", "discovery");
          mkdirSync(shotDir, { recursive: true });
          const shotPath = join("discovery", (route.replace(/[^a-z0-9]+/gi, "_") || "root") + ".png");
          await page.screenshot({ path: join(shotDir, shotPath), fullPage: false });
          page_.screenshotPath = shotPath.split(/[\\/]/).join("/");
        } catch { /* screenshots are best-effort */ }
        pages.push(page_);
      } catch {
        // A page that fails to load is still informative by its absence — skip it.
      }
    };

    if (options?.onlyRoutes?.length) {
      for (const route of options.onlyRoutes.slice(0, MAX_PAGES)) await visit(route);
      return { pages: pages.filter((entry, index) => index === 0 || entry.buttons.length || entry.inputs.length || entry.headings.length || entry.navItems.length || entry.clickables.length) };
    }
    await visit("/");
    // Same-origin links found on the entry page + the static route table.
    const foundLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => (anchor as HTMLAnchorElement).href)
        .filter((href) => href.startsWith(window.location.origin))
        .map((href) => new URL(href).pathname)
        .filter((path) => path !== "/" && !path.match(/\.(png|jpe?g|svg|css|js|ico|woff2?)$/i))
    );
    const candidates = [...new Set([...extraRoutes.filter((route) => route && route !== "*" && !route.includes(":")), ...foundLinks])];
    for (const route of candidates) await visit(route);

    // Drop pages whose title duplicates the shell and that discovered nothing (auth gates etc.).
    const meaningful = pages.filter((entry, index) => index === 0 || entry.buttons.length || entry.inputs.length || entry.headings.length || entry.navItems.length);
    return { pages: meaningful.map((entry) => ({ ...entry, title: entry.title || firstTitle })) };
  } catch (error) {
    return { pages, error: error instanceof Error ? error.message : "live discovery failed" };
  } finally {
    try { await browser?.close(); } catch { /* already closed */ }
  }
}
