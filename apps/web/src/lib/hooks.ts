"use client";

import type { Permission } from "@ai-qa/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, listProjects, type ProjectSummaryDto } from "./api";

const selectedKey = "proofline.selectedProjectId";

export function useProjects() {
  const [projects, setProjects] = useState<ProjectSummaryDto[] | null>(null);
  const [selected, setSelected] = useState<ProjectSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listProjects();
      setProjects(data);
      setSelected((current) => {
        const stored = window.localStorage.getItem(selectedKey);
        return data.find((project) => project.id === stored) ?? data[0] ?? null;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load projects");
    }
  }, []);

  useEffect(() => {
    const token = window.localStorage.getItem("proofline.accessToken");
    if (!token) { window.location.assign("/signin"); return; }
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selected) window.localStorage.setItem(selectedKey, selected.id);
  }, [selected]);

  return { projects, selected, setSelected, refresh, error };
}

export interface MePayload {
  id: string;
  email: string;
  displayName: string;
  isSuperadmin: boolean;
  emailVerifiedAt: string | null;
  createdAt: string;
  role: string | null;
  permissions: string[];
  organization: { id: string; name: string; industry: string | null; organizationSize: string | null; country: string | null; subscription?: { status: string; plan?: { key: string; name: string; tokenQuotaMonthly: number; executionSlotLimit: number } | null } | null } | null;
}

// Survives client-side navigation: every page mounts its own AppShell, and without this the
// sidebar and account block fall back to "Loading…" on each module switch until /me returns.
let cachedMe: MePayload | null = null;
const meStorageKey = "proofline.me";
const storeMe = (me: MePayload | null) => {
  cachedMe = me;
  try { if (me) window.sessionStorage.setItem(meStorageKey, JSON.stringify(me)); else window.sessionStorage.removeItem(meStorageKey); } catch { /* storage unavailable */ }
};

export function useMe() {
  const [me, setMe] = useState<MePayload | null>(cachedMe);
  useEffect(() => {
    const token = window.localStorage.getItem("proofline.accessToken");
    if (!token) { storeMe(null); window.location.assign("/signin"); return; }
    // Full reloads lose the module cache; restore from sessionStorage after hydration (not in useState, to avoid an SSR mismatch).
    if (!cachedMe) {
      try { const saved = window.sessionStorage.getItem(meStorageKey); if (saved) { cachedMe = JSON.parse(saved) as MePayload; setMe(cachedMe); } } catch { /* ignore bad data */ }
    }
    const update = (next: MePayload) => { storeMe(next); setMe(next); };
    api<MePayload>("/v1/auth/me").then(update).catch(() => { storeMe(null); window.location.assign("/signin"); });
    // Profile edits broadcast the fresh payload so every useMe() (e.g. the sidebar) updates in place.
    const onUpdate = (event: Event) => update((event as CustomEvent<MePayload>).detail);
    window.addEventListener(meUpdatedEvent, onUpdate);
    return () => window.removeEventListener(meUpdatedEvent, onUpdate);
  }, []);
  return me;
}

const meUpdatedEvent = "proofline:me-updated";
export const publishMe = (me: MePayload) => window.dispatchEvent(new CustomEvent(meUpdatedEvent, { detail: me }));

export function useToast() {
  const [toast, setToast] = useState<{ message: string; tone: "info" | "success" | "error" } | null>(null);
  const timer = useRef<number | null>(null);
  const dismiss = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setToast(null);
  }, []);
  const notify = useCallback((message: string, tone: "info" | "success" | "error" = "info") => {
    // A newer toast owns the timer; the old timeout must not clear it early.
    if (timer.current) window.clearTimeout(timer.current);
    setToast({ message, tone });
    timer.current = window.setTimeout(() => setToast(null), tone === "error" ? 10_000 : Math.min(9_000, 3_600 + message.length * 40));
  }, []);
  return { toast, notify, dismiss };
}

/** Elapsed time since `since` (epoch ms) as "45s" / "2m 05s", ticking once a second while `active`; null otherwise. */
export function useElapsed(since: number | null, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!active || since == null) return null;
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

/** True when the signed-in user's role grants `permission` (false while the profile is loading). */
export function can(me: MePayload | null, permission: Permission) {
  return !!me?.permissions.includes(permission);
}

const upgradeEvent = "proofline:upgrade-required";
const paidStatuses = ["TRIALING", "ACTIVE", "PAYMENT_WARNING"];

/**
 * Call at the top of an action handler: when the org has no active plan it opens the upgrade
 * modal (rendered by AppShell) and returns true, so the caller should bail out. Mirrors the API's billing gate.
 */
export function requireSubscription(me: MePayload | null) {
  const status = me?.organization?.subscription?.status;
  if (!status || paidStatuses.includes(status)) return false;
  window.dispatchEvent(new Event(upgradeEvent));
  return true;
}
export { upgradeEvent };
