"use client";

import { useEffect, useRef, useState } from "react";

const PRESENCE_PORT = 43117;
const PROBE_INTERVAL_MS = 2000;
const PROBE_TIMEOUT_MS = 1500;
const INSTALLED_FLAG = "proofline.recorderInstalled";

/** The recorder's local presence endpoint, probed on EVERY loopback spelling: the
 *  literal IPv4 address (no DNS involved at all), "localhost" (which some Linux
 *  setups resolve to IPv6 first — or only), and the literal IPv6 loopback. The
 *  recorder serves 127.0.0.1 AND [::1], so whichever spelling the browser picks,
 *  a RUNNING recorder is always reachable and never looks falsely absent. */
const PRESENCE_URLS = [
  `http://127.0.0.1:${PRESENCE_PORT}/ping`,
  `http://localhost:${PRESENCE_PORT}/ping`,
  `http://[::1]:${PRESENCE_PORT}/ping`
];

/** Live probe result: whether the recorder answered, plus the version it reported
 *  (null when the answer came through the opaque no-cors fallback). The version
 *  lets the UI confirm WHICH build is actually running — the difference between
 *  "detection broken" and "an outdated AppImage is still installed". */
export type RecorderPresence = { running: boolean; version: string | null };

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { cache: "no-store", ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

/** Asks the recorder's local presence endpoint whether the app is running right now.
 *  Loopback is mixed-content-exempt, so this works from the HTTPS production site too.
 *  Each URL is probed two complementary ways: a normal CORS request (which validates
 *  the JSON reply and reads the recorder's version), then — only if that was
 *  rejected — a no-cors request whose opaque response can't be read but whose mere
 *  existence proves the recorder answered, even when a proxy or browser quirk
 *  mangles the CORS handshake. A rejection everywhere (connection refused, or the
 *  browser blocking the local probe) means "not running". */
export async function probeRecorder(): Promise<RecorderPresence> {
  for (const url of PRESENCE_URLS) {
    try {
      const response = await fetchWithTimeout(url, { mode: "cors" });
      if (response.ok) {
        const version = await response.json()
          .then((body) => (typeof body?.version === "string" ? body.version : null))
          .catch(() => null);
        return { running: true, version };
      }
    } catch { /* rejected: no CORS-valid answer from this URL — try the fallback */ }
    try {
      const response = await fetchWithTimeout(url, { mode: "no-cors" });
      // An opaque response resolved at all = something answered on the port.
      if (response.type === "opaque") return { running: true, version: null };
    } catch { /* connection refused or blocked by the browser — keep trying */ }
  }
  return { running: false, version: null };
}

/** Sticky "was ever detected" flag — survives reloads even if the app is quit later. */
export function readRecorderInstalledFlag(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(INSTALLED_FLAG) === "1";
}

export function persistRecorderInstalled() {
  try { window.localStorage.setItem(INSTALLED_FLAG, "1"); } catch {}
}

export function clearRecorderInstalledFlag() {
  try { window.localStorage.removeItem(INSTALLED_FLAG); } catch {}
}

/**
 * Live recorder detection for the whole page: probes the recorder's local presence
 * endpoint immediately, then every 2 seconds, and again whenever the browser window
 * regains focus or the tab becomes visible (the user just ran the installer in a
 * terminal and switched back). The moment the recorder is installed and running —
 * no recording started, no window opened — `detected` flips to true so the UI can
 * react in real time: enable "Record steps in a browser", show the green check, and
 * disable downloads. `version` carries the build the recorder reported, so the UI
 * can display it (and an outdated build becomes visible at a glance).
 *
 * `onDetected` fires exactly once per detection transition (false → true) so callers
 * can persist the sticky installed flag.
 */
export function useRecorderPresence(onDetected?: () => void): { detected: boolean; version: string | null } {
  const [detected, setDetected] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  // Keep the latest callback without re-subscribing the pollers on every render.
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;

  useEffect(() => {
    let cancelled = false;
    let previouslyDetected = false;

    const probe = async () => {
      const presence = await probeRecorder();
      if (cancelled) return;
      setDetected(presence.running);
      setVersion(presence.version);
      if (presence.running && !previouslyDetected) {
        previouslyDetected = true;
        onDetectedRef.current?.();
      }
      if (!presence.running) previouslyDetected = false;
    };

    void probe();
    const interval = window.setInterval(() => void probe(), PROBE_INTERVAL_MS);
    // Coming back to the tab (focus, or visibility toggling back to visible — e.g.
    // after running the installer in a terminal) re-probes instantly instead of
    // waiting for the next tick.
    const onFocus = () => void probe();
    const onVisibility = () => { if (document.visibilityState === "visible") void probe(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { detected, version };
}
