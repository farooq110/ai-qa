"use client";

import { useEffect, useState } from "react";
import { Check, CircleDot, Download, X } from "lucide-react";

type Platform = "windows" | "mac" | "linux";

/** The user's OS — preselects the matching installer card. */
function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent;
  if (/Mac|Darwin/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "windows";
  return "linux";
}

const PRESENCE_URL = "http://127.0.0.1:43117/ping";

/** Asks the recorder's local presence endpoint whether the app is running right now.
 *  Loopback is mixed-content-exempt, so this works from the HTTPS production site too. */
async function probeRecorder(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 1500);
    const response = await fetch(PRESENCE_URL, { signal: controller.signal, cache: "no-store" });
    window.clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

const PLATFORMS: Array<{ key: Platform; label: string; file: string }> = [
  { key: "windows", label: "Windows", file: "ProoflineRecorder-Setup.exe" },
  { key: "mac", label: "macOS", file: "ProoflineRecorder.dmg" },
  { key: "linux", label: "Linux", file: "ProoflineRecorder.AppImage" }
];

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
  const selected = PLATFORMS.find((entry) => entry.key === platform)!;

  // Live detection: while the modal is open, poll the recorder's local presence
  // endpoint. The moment the app is installed and running, the indicator flips
  // green — no page refresh, no recording needed. Loopback is mixed-content-exempt
  // and the endpoint answers CORS/PNA preflights, so this works from any origin
  // including the HTTPS production site.
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      const alive = await probeRecorder();
      if (cancelled) return;
      setRunning(alive);
      if (alive && !installed) onDetected();
    };
    void probe();
    const interval = window.setInterval(() => void probe(), 2000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [installed, onDetected]);

  const effectivelyInstalled = installed || running;

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
              {effectivelyInstalled ? "Installed on this computer" : "Not installed yet"}
            </span>
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
                <li>Download the AppImage, make it executable, and run it once — this registers it with your system and enables autostart:
                  <code>chmod +x ProoflineRecorder.AppImage &amp;&amp; ./ProoflineRecorder.AppImage</code>
                  <small>If it doesn&apos;t start, run it with <code>--appimage-extract-and-run</code>.</small>
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
