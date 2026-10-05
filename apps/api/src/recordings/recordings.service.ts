import { Injectable, NotFoundException, OnModuleDestroy } from "@nestjs/common";
import { chromium, type Browser, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";

export interface RecordEvent {
  action: "click" | "fill" | "select";
  target: string;
  value?: string;
}

interface RecordingSession {
  id: string;
  projectId: string;
  organizationId: string;
  url: string;
  browser: Browser;
  page: Page;
  events: RecordEvent[];
  startedAt: Date;
  autoStop?: NodeJS.Timeout;
}

const MAX_SESSION_MS = 10 * 60 * 1000;

const RECORDER_SCRIPT = `
  (() => {
    const clean = (v) => (v || "").replace(/\\s+/g, " ").trim();
    const describe = (el) => {
      const aria = el.getAttribute("aria-label");
      if (aria) return clean(aria);
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        return clean(el.placeholder || el.name || el.id || el.getAttribute("type") || "field");
      }
      if (el.tagName === "SELECT") {
        return clean(el.getAttribute("aria-label") || el.name || el.id || "dropdown");
      }
      const text = clean(el.textContent || "");
      if (text && text.length <= 60) return text;
      const path = [];
      let cur = el;
      while (cur && cur.tagName !== "BODY" && path.length < 5) {
        let sel = cur.tagName.toLowerCase();
        if (cur.id) { sel += "#" + cur.id; path.unshift(sel); break; }
        const parent = cur.parentElement;
        if (!parent) { path.unshift(sel); break; }
        const siblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (siblings.length > 1) sel += ":nth-child(" + (Array.prototype.indexOf.call(parent.children, cur) + 1) + ")";
        path.unshift(sel);
        cur = parent;
      }
      return "css:" + path.join(" > ");
    };
    document.addEventListener("click", (e) => {
      const el = e.target.closest("button, a, [role=button], [onclick], label, .cursor-pointer") || e.target;
      try { window.__prooflineRecord({ action: "click", target: describe(el) }); } catch (err) {}
    }, true);
    document.addEventListener("change", (e) => {
      const el = e.target;
      if (el.tagName === "SELECT") {
        try { window.__prooflineRecord({ action: "select", target: describe(el), value: el.value }); } catch (err) {}
      } else if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.type !== "checkbox" && el.type !== "radio" && el.type !== "submit") {
        const meta = (el.placeholder || "") + (el.name || "") + (el.id || "") + (el.getAttribute("aria-label") || "");
        const isSecret = el.type === "password" || /password/i.test(meta);
        try { window.__prooflineRecord({ action: "fill", target: describe(el), value: isSecret ? "{{password}}" : el.value }); } catch (err) {}
      }
    }, true);
  })();
`;

@Injectable()
export class RecordingsService implements OnModuleDestroy {
  private sessions = new Map<string, RecordingSession>();

  constructor(private readonly prisma: PrismaService) {}

  async start(user: AuthenticatedUser, projectId: string, url: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    if (!url?.trim()) throw new NotFoundException("A start URL is required");

    const id = randomUUID();
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const session: RecordingSession = {
      id,
      projectId,
      organizationId: user.organizationId,
      url,
      browser,
      page,
      events: [],
      startedAt: new Date()
    };
    this.sessions.set(id, session);

    await page.exposeFunction("__prooflineRecord", (event: RecordEvent) => {
      const last = session.events[session.events.length - 1];
      if (last && last.action === event.action && last.target === event.target) return;
      session.events.push(event);
    });
    await context.addInitScript(RECORDER_SCRIPT);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(2_500);

    session.autoStop = setTimeout(() => {
      this.stop(user.organizationId, session.projectId, id).catch(() => undefined);
    }, MAX_SESSION_MS);
    return { sessionId: id, url, events: 0 };
  }

  private async assertSessionAccess(user: AuthenticatedUser, projectId: string, sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.projectId !== projectId) throw new NotFoundException("Recording session not found");
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Recording session not found");
    return session;
  }

  async events(user: AuthenticatedUser, projectId: string, sessionId: string) {
    const session = await this.assertSessionAccess(user, projectId, sessionId);
    return { events: session.events, count: session.events.length };
  }

  async stop(organizationId: string, projectId: string, sessionId: string) {
    const session = await this.assertSessionAccess({ organizationId } as AuthenticatedUser, projectId, sessionId);
    clearTimeout(session.autoStop);
    this.sessions.delete(sessionId);
    const events = [...session.events];
    await session.browser.close().catch(() => undefined);
    return { events, count: events.length };
  }

  async onModuleDestroy() {
    for (const session of this.sessions.values()) {
      clearTimeout(session.autoStop);
      await session.browser.close().catch(() => undefined);
    }
    this.sessions.clear();
  }
}
