import { firstFixtures, type RouteFixtures } from "@ai-qa/test-dsl";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PERMISSIONS } from "@ai-qa/domain";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PermissionsService } from "../rbac/permissions.service";
import { crawlApp } from "../analysis/crawler";
import { discoveryAuth } from "../analysis/live-discovery";
import { loadSessionState, sessionStore } from "../common/environment-session";

@Injectable()
export class RouteMapService {
  constructor(private readonly prisma: PrismaService, private readonly permissions: PermissionsService) {}

  private async project(user: AuthenticatedUser, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    return project;
  }

  async list(user: AuthenticatedUser, projectId: string) {
    await this.project(user, projectId);
    const [rows, environment] = await Promise.all([
      this.prisma.projectRoute.findMany({ where: { projectId }, omit: { inventory: true }, orderBy: [{ navOrder: "asc" }, { pattern: "asc" }] }),
      this.prisma.environmentProfile.findFirst({ where: { projectId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] })
    ]);
    const fixtures = firstFixtures(environment?.routeFixtures);
    return { routes: rows.map((row) => ({ ...row, fixture: fixtures[row.pattern] ?? null })), environment: environment ? { id: environment.id, name: environment.name } : null };
  }

  async add(user: AuthenticatedUser, projectId: string, input: { pattern?: string; label?: string }) {
    await this.permissions.assert(user, PERMISSIONS.TEST_CASES_CREATE);
    await this.project(user, projectId);
    const raw = String(input.pattern ?? "").trim();
    if (!raw || /\s/.test(raw) || raw === "*") throw new BadRequestException("Enter a path such as /orders or /orders/:id");
    const pattern = ("/" + raw.replace(/^https?:\/\/[^/]+/i, "")).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
    const existing = await this.prisma.projectRoute.findUnique({ where: { projectId_pattern: { projectId, pattern } } });
    if (existing) return this.prisma.projectRoute.update({ where: { id: existing.id }, data: { excluded: false, pinned: true, sources: [...new Set([...existing.sources, "user"])] } });
    return this.prisma.projectRoute.create({ data: { projectId, pattern, label: input.label?.trim() || null, sources: ["user"], pinned: true, status: "DISCOVERED", reason: "added by you; verify it to enable tests" } });
  }

  async update(user: AuthenticatedUser, projectId: string, routeId: string, input: { pinned?: boolean; excluded?: boolean; label?: string; fixture?: Record<string, string> | null }) {
    await this.permissions.assert(user, PERMISSIONS.TEST_CASES_CREATE);
    await this.project(user, projectId);
    const row = await this.prisma.projectRoute.findFirst({ where: { id: routeId, projectId } });
    if (!row) throw new NotFoundException("Route not found");
    if (input.fixture !== undefined) {
      const environment = await this.prisma.environmentProfile.findFirst({ where: { projectId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
      if (!environment) throw new BadRequestException("Add an environment first: parameter values are stored per environment.");
      const fixtures = { ...((environment.routeFixtures ?? {}) as RouteFixtures) };
      const values = input.fixture && Object.fromEntries(Object.entries(input.fixture).map(([name, value]) => [name, String(value)]));
      const current = fixtures[row.pattern];
      if (!values) delete fixtures[row.pattern];
      // Editing the values here edits the first set; the rest of a list (other models) is kept.
      else fixtures[row.pattern] = Array.isArray(current) && current.length > 1 ? [values, ...current.slice(1)] : values;
      await this.prisma.environmentProfile.update({ where: { id: environment.id }, data: { routeFixtures: fixtures as never } });
    }
    return this.prisma.projectRoute.update({
      where: { id: row.id },
      data: {
        ...(input.pinned !== undefined ? { pinned: Boolean(input.pinned) } : {}),
        ...(input.excluded !== undefined ? { excluded: Boolean(input.excluded) } : {}),
        ...(input.label !== undefined ? { label: input.label.trim() || null } : {})
      },
      omit: { inventory: true }
    });
  }

  /** Re-open one route in the live app (logs in first) and update its status. Runs inline: one login, one page. */
  async verify(user: AuthenticatedUser, projectId: string, routeId: string) {
    await this.permissions.assert(user, PERMISSIONS.TEST_CASES_CREATE);
    await this.project(user, projectId);
    const row = await this.prisma.projectRoute.findFirst({ where: { id: routeId, projectId } });
    if (!row) throw new NotFoundException("Route not found");
    const environment = await this.prisma.environmentProfile.findFirst({ where: { projectId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
    if (!environment?.url) throw new BadRequestException("Add an environment URL in Settings first.");
    // Reuses (and refreshes) the environment's saved login: a fresh login per re-verify would spend the app's login rate limit.
    const crawl = await crawlApp(environment.url.replace(/\/$/, ""), { auth: discoveryAuth(environment), hints: [row.pattern], onlyHints: true, maxPages: 1, sessionState: loadSessionState(environment), sessionStore: sessionStore(this.prisma, environment.id) });
    if (crawl.login === "failed") throw new BadRequestException(`Login failed${crawl.loginRateLimited ? " (the app rate-limited it; wait a few minutes)" : ""}. Check the credentials in Settings.`);
    const found = crawl.routes.find((route) => route.pattern === row.pattern);
    const verified = Boolean(found?.verified);
    return this.prisma.projectRoute.update({
      where: { id: row.id },
      data: {
        status: verified ? "VERIFIED" : "UNREACHABLE",
        reason: verified ? null : found?.reason ?? crawl.error ?? "the page could not be opened",
        ...(found?.page ? { inventory: found.page as never, apiCalls: found.apiCalls } : {}),
        lastVerifiedAt: verified ? new Date() : row.lastVerifiedAt
      },
      omit: { inventory: true }
    });
  }

  /** Recorder sessions seed the map: every page the person visited is a route they care about. */
  async addVisited(projectId: string, urls: string[]) {
    for (const url of urls) {
      try {
        const { pathname, search } = new URL(url);
        const { clusterPath } = await import("../analysis/crawler");
        const { pattern } = clusterPath(pathname + search);
        await this.prisma.projectRoute.upsert({
          where: { projectId_pattern: { projectId, pattern } },
          create: { projectId, pattern, sources: ["recorder"], status: "DISCOVERED", reason: "visited in a recording; verify it to enable tests" },
          update: {}
        });
      } catch { /* not a URL */ }
    }
  }
}
