"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CircleDot, Copy, Download, RotateCw, X } from "lucide-react";
import { probeRecorder } from "@/lib/use-recorder-presence";

type Platform = "windows" | "mac" | "linux";

/** The user's OS — preselects the matching installer card. */
function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent;
  if (/Mac|Darwin/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "windows";
  return "linux";
}

const PLATFORMS: Array<{ key: Platform; label: string; file: string }> = [
  { key: "windows", label: "Windows", file: "ProoflineRecorder-Setup.exe" },
  { key: "mac", label: "macOS", file: "ProoflineRecorder.dmg" },
  { key: "linux", label: "Linux", file: "ProoflineRecorder.AppImage" }
];

/** One-click copy for terminal commands: the async Clipboard API on secure origins
 *  (HTTPS / localhost), with a legacy execCommand fallback so it also works on
 *  plain-HTTP LAN deployments where navigator.clipboard is unavailable. */
function CopyButton({ text, disabled = false }: { text: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const copy = async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; }
    } catch { ok = false; }
    if (!ok) {
      // Non-secure origins (plain HTTP on a LAN) have no async Clipboard API —
      // fall back to the legacy path so the button works everywhere.
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        ok = document.execCommand("copy");
        area.remove();
      } catch { ok = false; }
    }
    if (!ok) return;
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      className={"copy-button" + (copied ? " copied" : "")}
      disabled={disabled}
      onClick={() => void copy()}
      title={copied ? "Copied to clipboard" : disabled ? "Already installed on this computer" : `Copy command: ${text}`}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * On-demand recorder setup: open/close whenever the user wants, never auto-shown.
 * When the recorder is already installed on this machine, downloads are disabled —
 * instructions stay viewable, and only the Open action remains.
 */
export function RecorderSetupModal({ apiUrl, installed, deepLink, onClose, onLaunch, onUninstall, onDetected }: {
  apiUrl: string;
  installed: boolean;
  deepLink: string | null;
  onClose: () => void;
  onLaunch: (link: string) => void;
  onUninstall: () => void;
  onDetected: () => void;
}) {
  const [platform, setPlatform] = useState<Platform>(detectPlatform);
  const [running, setRunning] = useState(false);
  // Build the running recorder reported through /ping — displayed next to the
  // installed chip so an outdated AppImage is visible at a glance (v1.1.0 is the
  // first build that serves the endpoint on both loopback stacks).
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  // null until measured client-side (avoids SSR hydration mismatches).
  const [secureContext, setSecureContext] = useState<boolean | null>(null);
  // "granted" | "prompt" | "denied" from the Permissions API; "unknown" where the
  // browser doesn't implement the local-network-access permission (e.g. Firefox).
  const [lnaState, setLnaState] = useState<"granted" | "prompt" | "denied" | "unknown">("unknown");
  const selected = PLATFORMS.find((entry) => entry.key === platform)!;
  const probeNowRef = useRef<() => void>(() => {});

  // Chrome 142+ gates requests from public sites to local apps (127.0.0.1 included)
  // behind the "Local network access" site permission — surfacing its state tells
  // the user exactly why the probe isn't flipping the chip yet, and how to fix it.
  useEffect(() => {
    setSecureContext(window.isSecureContext);
    let status: PermissionStatus | null = null;
    const update = () => setLnaState((status?.state as "granted" | "prompt" | "denied") ?? "unknown");
    try {
      navigator.permissions
        ?.query?.({ name: "local-network-access" } as unknown as PermissionDescriptor)
        .then((result) => { status = result; update(); result.onchange = update; })
        .catch(() => setLnaState("unknown"));
    } catch { setLnaState("unknown"); }
    return () => { if (status) status.onchange = null; };
  }, []);

  // Live detection: while the modal is open, poll the recorder's local presence
  // endpoint — plus an immediate re-probe when the browser window regains focus or
  // the tab becomes visible (the user just ran the installer in a terminal and
  // switched back), and a "Check again" button for an instant, gesture-driven probe.
  // The moment the app is installed and running the indicator flips green and every
  // download button disables — no page refresh, no recording, no recorder window
  // needed. Loopback is mixed-content-exempt and the endpoint answers CORS and
  // network-access preflights, so this works from any origin including HTTPS.
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      const presence = await probeRecorder();
      if (cancelled) return;
      setRunning(presence.running);
      setServerVersion(presence.version);
      if (presence.running && !installed) onDetected();
    };
    probeNowRef.current = () => {
      setRechecking(true);
      window.setTimeout(() => setRechecking(false), 600);
      void probe();
    };
    void probe();
    const interval = window.setInterval(() => void probe(), 2000);
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
  }, [installed, onDetected]);

  const effectivelyInstalled = installed || running;
  const installedLabel = effectivelyInstalled
    ? `Installed on this computer${serverVersion ? ` \u00b7 v${serverVersion}` : ""}`
    : "Not installed yet";
  const linuxDownloadCommand = `curl -L -o ProoflineRecorder.AppImage "${apiUrl}/v1/recordings/installer/linux"`;
  const linuxRunCommand = "chmod +x ProoflineRecorder.AppImage && ./ProoflineRecorder.AppImage";

  return (
    <div className="modal-backdrop setup-backdrop" role="dialog" aria-modal="true">
      <div className="modal setup-modal">
        <header>
          <div>
            <h2>Recorder setup</h2>
            <p className="meta">Browser recording runs in the Proofline Recorder desktop app on your computer.</p>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="modal-body">
          <div className="setup-status-row">
            <span className={"setup-chip " + (effectivelyInstalled ? "ok" : "")}>
              {effectivelyInstalled ? <Check size={11} /> : <CircleDot size={11} />}
              {installedLabel}
            </span>
            {!effectivelyInstalled && (
              <button
                type="button"
                className="mini-button"
                onClick={() => probeNowRef.current()}
                title="Re-check immediately — this click also gives Chrome the user gesture it needs to show its local-network permission prompt"
              >
                <RotateCw size={12} className={rechecking ? "spin" : undefined} />Check again
              </button>
            )}
            {effectivelyInstalled && (
              <button
                type="button"
                className="mini-button danger"
                title="Remove the recorder from this computer (registration, autostart, and app files)"
                onClick={() => {
                  // The OS launches the recorder's uninstall routine via the protocol.
                  window.location.href = "proofline-recorder://uninstall";
                  setRunning(false);
                  onUninstall();
                }}
              >
                <X size={12} />Uninstall
              </button>
            )}
          </div>
          {!effectivelyInstalled && (
            <div className="setup-detect-hint">
              {lnaState === "denied" ? (
                <small className="warn">
                  This browser is currently blocking local detection for this site — click the site/tune icon left of the address bar → <b>Site settings</b> → set <b>Local network access</b> to <b>Allow</b>, then reload the page.
                </small>
              ) : secureContext === false ? (
                <small className="warn">
                  This page is not a secure context (HTTPS or localhost) — browsers refuse to let plain-HTTP pages detect local apps, so the recorder can never be detected here. Serve the web app over HTTPS or from localhost.
                </small>
              ) : (
                <small>
                  After the install command starts the recorder, this flips to <b>Installed</b> within seconds — no recorder window needed. Chrome may ask to allow <b>Local network access</b> for this site: choose <b>Allow</b> so the site can see the recorder.
                </small>
              )}
            </div>
          )}

          <div className="setup-section">
            <strong>Open the recorder</strong>
            {deepLink ? (
              <>
                <p className="muted">Launch the recorder for your current recording session — your app opens in its window and every action is captured.</p>
                <button type="button" className="primary-button" onClick={() => onLaunch(deepLink)}><CircleDot size={14} />Open the Proofline Recorder</button>
              </>
            ) : (
              <p className="muted">Start a recording first (Record steps in a browser) — the recorder opens automatically when a session is active.</p>
            )}
          </div>

          <div className="setup-section">
            <strong>Install / instructions</strong>
            <div className="platform-cards" role="tablist" aria-label="Choose your platform">
              {PLATFORMS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  aria-selected={platform === entry.key}
                  className={"platform-card" + (platform === entry.key ? " active" : "")}
                  onClick={() => setPlatform(entry.key)}
                >
                  <strong>{entry.label}</strong>
                  <small>{entry.file}</small>
                </button>
              ))}
            </div>
            {platform === "linux" && (
              <ol className="record-steps">
                <li>
                  <strong>Download AppImage</strong>
                  <small>Save the recorder to your computer — with the download button below, or the terminal command:</small>
                  <div className="command-row">
                    <code>curl -L -o ProoflineRecorder.AppImage &quot;{apiUrl}/v1/recordings/installer/linux&quot;</code>
                    <CopyButton text={linuxDownloadCommand} disabled={effectivelyInstalled} />
                  </div>
                </li>
                <li>
                  <strong>Make It Executable</strong>
                  <small>Then run it once — this registers it with your system, enables autostart, and starts the recorder (the website detects it immediately):</small>
                  <div className="command-row">
                    <code>chmod +x ProoflineRecorder.AppImage &amp;&amp; ./ProoflineRecorder.AppImage</code>
                    <CopyButton text={linuxRunCommand} />
                  </div>
                  <small>If it doesn&apos;t start, run it with <code>--appimage-extract-and-run</code>.</small>
                  <small>Linux may ask to confirm the first launch — browsers on Linux sometimes label the launcher generically as <code>xdg-open</code>; choosing Open (and, if offered, <i>Always allow</i>) starts the Proofline Recorder.</small>
                  <small className="warn">
                    Still shows <b>Not installed</b> and the browser console logs <code>net::ERR_CONNECTION_REFUSED</code> for the ping? That means no recorder is listening on this machine: run the command above in a terminal — the first lines must print <code>presence endpoint on http://127.0.0.1:43117/ping</code>. If they don&apos;t, the AppImage you have is an outdated build — download it again with the button/command above and re-run it (the new launch replaces the old registration automatically).
                  </small>
                </li>
              </ol>
            )}
            {platform === "windows" && (
              <ol className="record-steps">
                <li>Download and run <code>ProoflineRecorder-Setup.exe</code>, then follow the installer. The protocol and login autostart are registered automatically.</li>
              </ol>
            )}
            {platform === "mac" && (
              <ol className="record-steps">
                <li>Download the disk image, open it, and drag <b>Proofline Recorder</b> to Applications. Launch it once to register the protocol and autostart.</li>
              </ol>
            )}
            <a
              className="primary-button setup-download"
              href={effectivelyInstalled ? undefined : `${apiUrl}/v1/recordings/installer/${platform}`}
              aria-disabled={effectivelyInstalled}
              title={effectivelyInstalled ? "Already installed on this computer" : `Download ${selected.file}`}
              onClick={effectivelyInstalled ? (event) => event.preventDefault() : undefined}
            >
              <Download size={14} />
              {effectivelyInstalled ? "Already installed" : `Download for ${selected.label}`}
            </a>
          </div>
        </div>
        <footer>
          <button className="modal-cancel" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  );
}
