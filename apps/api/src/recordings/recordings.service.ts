import { Injectable, BadRequestException, NotFoundException, OnModuleDestroy } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";

export interface RecordEvent {
  action: "click" | "fill" | "select" | "navigate";
  target: string;
  value?: string;
}

type SessionStatus = "awaiting-client" | "recording" | "stopped";

interface RecordingSession {
  id: string;
  projectId: string;
  organizationId: string;
  url: string;
  status: SessionStatus;
  events: RecordEvent[];
  screenshot: string | null;
  createdAt: Date;
  autoStop?: NodeJS.Timeout;
  gc?: NodeJS.Timeout;
}

const MAX_SESSION_MS = 10 * 60 * 1000;
const STOPPED_SESSION_TTL_MS = 30 * 60 * 1000;
/** The recorder desktop app re-authenticates with this token; 20 min covers a 10 min session. */
const DEEP_LINK_TOKEN_TTL = "20m";
const MAX_EVENTS = 500;

@Injectable()
export class RecordingsService {
  private sessions = new Map<string, RecordingSession>();

  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService) {}

  /**
   * Creates a recording session and hands back a deep link for the Proofline Recorder
   * desktop app, which runs the browser on the user's machine (local and production
   * alike). The server never launches a browser itself.
   */
  async start(user: AuthenticatedUser, projectId: string, url: string, apiUrl: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    if (!url?.trim() || !/^https?:\/\//.test(url.trim())) throw new BadRequestException("A start URL is required");
    if (!apiUrl?.trim() || !/^https?:\/\//.test(apiUrl.trim())) throw new BadRequestException("The recorder needs the API base URL of this deployment");

    const id = randomUUID();
    const token = await this.jwt.signAsync(
      { sub: user.userId, userId: user.userId, organizationId: user.organizationId, role: user.role, sessionId: id },
      { expiresIn: DEEP_LINK_TOKEN_TTL }
    );
    const session: RecordingSession = {
      id,
      projectId,
      organizationId: user.organizationId,
      url: url.trim(),
      status: "awaiting-client",
      events: [],
      screenshot: null,
      createdAt: new Date()
    };
    this.sessions.set(id, session);

    session.autoStop = setTimeout(() => {
      session.status = "stopped";
      // Keep events for a while so the web app's stop call can still import them.
      session.gc = setTimeout(() => this.sessions.delete(id), STOPPED_SESSION_TTL_MS);
    }, MAX_SESSION_MS);

    const deepLink = `proofline-recorder://record?session=${id}&project=${projectId}&token=${encodeURIComponent(token)}&api=${encodeURIComponent(apiUrl)}&target=${encodeURIComponent(session.url)}`;
    return { sessionId: id, url: session.url, events: 0, status: session.status, deepLink };
  }

  private async assertSessionAccess(user: AuthenticatedUser, projectId: string, sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.projectId !== projectId) throw new NotFoundException("Recording session not found");
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Recording session not found");
    return session;
  }

  /** Called by the recorder desktop app once it has opened the target URL. */
  async attach(user: AuthenticatedUser, projectId: string, sessionId: string) {
    const session = await this.assertSessionAccess(user, projectId, sessionId);
    if (session.status === "stopped") throw new BadRequestException("This recording session has already ended — start a new one.");
    session.status = "recording";
    return { url: session.url, status: session.status };
  }

  /** The recorder app replaces the full event list every few seconds, so the last push wins. */
  async pushEvents(user: AuthenticatedUser, projectId: string, sessionId: string, events: RecordEvent[], screenshot?: string) {
    const session = await this.assertSessionAccess(user, projectId, sessionId);
    if (session.status === "stopped") throw new BadRequestException("This recording session has already ended — start a new one.");
    if (!Array.isArray(events)) throw new BadRequestException("events must be an array");
    const allowed: RecordEvent["action"][] = ["click", "fill", "select", "navigate"];
    session.events = events
      .slice(-MAX_EVENTS)
      .filter((event) => event && allowed.includes(event.action))
      .map((event) => ({ action: event.action, target: String(event.target ?? ""), ...(event.value === undefined ? {} : { value: String(event.value) }) }));
    if (typeof screenshot === "string") session.screenshot = screenshot;
    if (session.status === "awaiting-client") session.status = "recording";
    return { count: session.events.length, status: session.status };
  }

  async events(user: AuthenticatedUser, projectId: string, sessionId: string) {
    const session = await this.assertSessionAccess(user, projectId, sessionId);
    return { events: session.events, count: session.events.length, status: session.status };
  }

  /** Screenshot last pushed by the recorder app — used by the region picker. */
  async screenshot(user: AuthenticatedUser, projectId: string, sessionId: string) {
    const session = await this.assertSessionAccess(user, projectId, sessionId);
    if (!session.screenshot) throw new BadRequestException("No screenshot has been captured yet — make sure the Proofline Recorder app is recording.");
    return { image: session.screenshot, url: session.url };
  }

  async stop(organizationId: string, projectId: string, sessionId: string) {
    const session = await this.assertSessionAccess({ organizationId } as AuthenticatedUser, projectId, sessionId);
    const events = [...session.events];
    session.status = "stopped";
    clearTimeout(session.autoStop);
    clearTimeout(session.gc);
    session.gc = setTimeout(() => this.sessions.delete(sessionId), STOPPED_SESSION_TTL_MS);
    return { events, count: events.length };
  }

  async onModuleDestroy() {
    for (const session of this.sessions.values()) {
      clearTimeout(session.autoStop);
      clearTimeout(session.gc);
    }
    this.sessions.clear();
  }
}
