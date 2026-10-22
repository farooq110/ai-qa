"use client";

import { useEffect, useRef, useState } from "react";

const PRESENCE_PORT = 43117;
/** Exponential backoff: the first check runs 2s after the hook mounts (nothing is
 *  fired the moment a modal opens), every unsuccessful check doubles the wait,
 *  and the interval NEVER exceeds 10 seconds. */
const PROBE_INITIAL_INTERVAL_MS = 2000;
const PROBE_MAX_INTERVAL_MS = 10000;
const PROBE_TIMEOUT_MS = 1500;
/** Hard cap on automatic attempts per cycle: after 10 checks without a detection
 *  the poller stops entirely — no infinite background traffic. A manual refresh
 *  (`refresh`) starts a brand-new cycle with a fresh budget of 10 attempts. */
const MAX_PROBE_ATTEMPTS = 10;
const INSTALLED_FLAG = "proofline.recorderInstalled";

/** The recorder's local presence endpoint. The app listens on BOTH loopback
 *  families (127.0.0.1 and [::1]), so the literal IPv4 address works whenever
 *  the recorder is running; "localhost" and the IPv6 literal are kept as
 *  alternates for machines where a firewall or resolver quirk blocks one
 *  spelling. ONE spelling is probed per attempt — they rotate across attempts,
 *  so every spelling is covered within three checks while each individual
 *  attempt still sends exactly ONE request. */
const PRESENCE_URLS = [
  `http://127.0.0.1:${PRESENCE_PORT}`,
  `http://localhost:${PRESENCE_PORT}`,
  `http://[::1]:${PRESENCE_PORT}`
];

/** Live probe result: whether the recorder answered, plus the version it reported. */
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

/** ONE loopback spelling, ONE request. `spellingIndex` picks which URL this
 *  attempt uses (callers rotate it). A plain GET with no custom headers is a
 *  CORS "simple request", and the recorder's presence server answers the CORS
 *  handshake directly (Access-Control-Allow-Origin: * plus the private/non-local
 *  network opt-ins), so a RUNNING recorder is always detected this way — no
 *  multi-request sweeps, no no-cors fallback doubling the traffic. */
async function probeOnce(spellingIndex: number): Promise<RecorderPresence> {
  const base = PRESENCE_URLS[spellingIndex % PRESENCE_URLS.length];
  try {
    const response = await fetchWithTimeout(`${base}/ping`, { mode: "cors" });
    if (!response.ok) return { running: false, version: null };
    const version = await response.json()
      .then((body) => (typeof body?.version === "string" ? body.version : null))
      .catch(() => null);
    return { running: true, version };
  } catch {
    // Connection refused / blocked — not detected on this spelling this attempt.
    return { running: false, version: null };
  }
}

/** Asks the RUNNING recorder to uninstall itself over its local presence endpoint
 *  (POST /uninstall) — the browser-friendly replacement for the old
 *  `proofline-recorder://uninstall` deep link, which made Chrome show its
 *  "Open xdg-open?" / "No App Available" dialogs. A POST with no custom headers is
 *  a CORS "simple request", so no preflight is needed. One spelling at a time,
 *  stopping at the first that answers. Returns true when a running recorder
 *  accepted the request; false when nothing is listening (nothing to uninstall —
 *  the caller just clears its local state). */
export async function uninstallRecorder(): Promise<boolean> {
  for (const base of PRESENCE_URLS) {
    try {
      const response = await fetchWithTimeout(`${base}/uninstall`, { method: "POST", mode: "cors" });
      if (response.ok) return true;
    } catch { /* not answering on this spelling — try the next */ }
  }
  return false;
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
 * Live recorder detection for the whole page — ONE request at a time:
 *
 *  - Nothing is sent the moment the hook mounts (no request fires when a modal
 *    opens). The first check runs after the initial 2-second interval.
 *  - Each check is EXACTLY ONE fetch to ONE loopback spelling — never the old
 *    3-spellings × 2-modes burst of six requests. Spellings rotate across
 *    attempts so all of them are still covered.
 *  - After each UNSUCCESSFUL check the wait doubles: 2s → 4s → 8s → 10s, capped
 *    at 10 seconds forever after — the interval never exceeds 10s.
 *  - At most MAX_PROBE_ATTEMPTS (10) automatic attempts per cycle. A positive
 *    response stops the poller immediately; after 10 misses it stops for good
 *    (`exhausted` flips true) until the user refreshes.
 *  - `refresh()` is the manual button: it runs ONE immediate check and restarts
 *    the automatic cycle with a fresh 10-attempt budget (and a fresh backoff
 *    starting at 2s). Ignored while a check is already in flight, so requests
 *    never overlap.
 *  - `reset()` wipes the detected state and keeps polling stopped — used by the
 *    Uninstall flow, which must stop the ping requests entirely.
 *
 * When detection succeeds, `detected` flips to true so the UI can react in real
 * time: enable "Record steps in a browser", show the green check, and disable
 * downloads. `version` carries the build the recorder reported. `checking` is
 * true while a probe (automatic or manual) is in flight — buttons use it to
 * show a spinner and prevent double clicks.
 *
 * `onDetected` fires exactly once per detection transition (false → true) so callers
 * can persist the sticky installed flag.
 */
export function useRecorderPresence(onDetected?: () => void): {
  detected: boolean;
  version: string | null;
  /** True while a single probe is in flight (spinner / button disable). */
  checking: boolean;
  /** True when the automatic poller stopped after MAX_PROBE_ATTEMPTS misses. */
  exhausted: boolean;
  /** Manual check: one immediate request + restart the polling cycle (user gesture). */
  refresh: () => Promise<void>;
  /** Clear the detected state and keep polling stopped (uninstall flow). */
  reset: () => void;
} {
  const [detected, setDetected] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  // Keep the latest callback without re-subscribing the poller on every render.
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  // Latest manual actions, assigned inside the effect below (stable identities for
  // callers between renders — `refresh` / `reset` never change).
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const resetRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let stopped = false;    // polling halted (detected, reset, or attempts exhausted)
    let inFlight = false;   // a probe is running right now — no overlapping requests
    let generation = 0;     // bumped by reset() — stale in-flight results are dropped
    let attempts = 0;       // attempts spent in the current cycle (capped at 10)
    let waitsUsed = 0;      // backoff waits consumed in the current cycle
    let spelling = 0;       // rotates across loopback spellings, ONE per attempt

    const clearTimer = () => {
      if (timer !== null) { window.clearTimeout(timer); timer = null; }
    };

    /** The backoff wait before the next automatic attempt: 2s, 4s, 8s, then
     *  10s forever — NEVER above 10s. Counted per cycle, so a manual refresh
     *  restarts the ladder from 2s. */
    const nextDelay = () => Math.min(PROBE_INITIAL_INTERVAL_MS * 2 ** waitsUsed, PROBE_MAX_INTERVAL_MS);

    const armNext = () => {
      if (cancelled || stopped) return;
      const wait = nextDelay();
      waitsUsed += 1;
      timer = window.setTimeout(() => { void runAttempt(); }, wait);
    };

    const applyPresence = (presence: RecorderPresence) => {
      if (cancelled) return;
      if (!presence.running) { setDetected(false); setVersion(null); return; }
      // Detected: update state, persist once per transition, and STOP polling
      // immediately — no further requests while the recorder stays installed.
      setDetected(true);
      setVersion(presence.version);
      stopped = true;
      clearTimer();
      onDetectedRef.current?.();
    };

    // ONE request, then decide: detected → stop; 10th miss → stop; otherwise
    // arm the next attempt after the (backing-off) wait. Because the next timer
    // is only armed AFTER the response settles, requests never overlap.
    const runAttempt = async () => {
      if (cancelled || stopped || inFlight) return;
      inFlight = true;
      const attemptGeneration = generation;
      if (!cancelled) setChecking(true);
      const presence = await probeOnce(spelling++);
      inFlight = false;
      // Stale result: reset() (uninstall) ran while this probe was in flight —
      // its outcome must NOT flip the just-cleared state back.
      if (cancelled || attemptGeneration !== generation) { if (!cancelled) setChecking(false); return; }
      setChecking(false);
      attempts += 1;
      if (presence.running) { applyPresence(presence); return; }
      setDetected(false);
      setVersion(null);
      if (attempts >= MAX_PROBE_ATTEMPTS) {
        // Cycle budget spent — stop automatic polling entirely. The manual
        // refresh button can restart it at any time with a fresh budget.
        stopped = true;
        setExhausted(true);
        clearTimer();
        return;
      }
      armNext();
    };

    // Automatic cycle: first attempt after the initial 2s wait (nothing fires
    // at mount / modal-open time).
    armNext();

    // Manual, gesture-driven check ("Check for recorder" / "Check again"):
    // cancels any pending timer and restarts the cycle — one immediate request
    // now, then the automatic attempts resume exactly like a fresh cycle
    // (2s, 4s, 8s, 10s… with a new 10-attempt budget). Ignored while a request
    // is already in flight so requests never overlap.
    refreshRef.current = async () => {
      if (inFlight || cancelled) return;
      clearTimer();
      stopped = false;
      attempts = 0;
      waitsUsed = 0;
      setExhausted(false);
      await runAttempt();
    };

    resetRef.current = () => {
      stopped = true;
      generation += 1; // any in-flight probe's result is now stale — discard it
      inFlight = false;
      attempts = 0;
      waitsUsed = 0;
      clearTimer();
      if (!cancelled) { setDetected(false); setVersion(null); setChecking(false); setExhausted(false); }
    };

    return () => {
      cancelled = true;
      clearTimer();
    };
  }, []);

  return {
    detected,
    version,
    checking,
    exhausted,
    refresh: () => refreshRef.current(),
    reset: () => resetRef.current()
  };
}
