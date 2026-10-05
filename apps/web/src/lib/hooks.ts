"use client";

import { useCallback, useEffect, useState } from "react";
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
  role: string | null;
  organization: { id: string; name: string; industry: string | null; organizationSize: string | null; country: string | null; subscription?: { status: string; plan?: { key: string; name: string; tokenQuotaMonthly: number; executionSlotLimit: number } | null } | null } | null;
}

export function useMe() {
  const [me, setMe] = useState<MePayload | null>(null);
  useEffect(() => {
    const token = window.localStorage.getItem("proofline.accessToken");
    if (!token) { window.location.assign("/signin"); return; }
    api<MePayload>("/v1/auth/me").then(setMe).catch(() => { window.location.assign("/signin"); });
  }, []);
  return me;
}

export function useToast() {
  const [toast, setToast] = useState<{ message: string; tone: "info" | "success" | "error" } | null>(null);
  const notify = useCallback((message: string, tone: "info" | "success" | "error" = "info") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 3600);
  }, []);
  return { toast, notify };
}
