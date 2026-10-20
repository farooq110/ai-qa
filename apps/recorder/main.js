const { app, BrowserWindow, ipcMain } = require("electron");
const http = require("node:http");
const { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, statSync, existsSync, rmSync } = require("node:fs");
const { execSync } = require("node:child_process");
const { homedir } = require("node:os");
const path = require("node:path");
// Raw script text — injected into the recorded page. Never require() it: it is
// browser-only code and would execute in the main process.
const RECORDER_SCRIPT = readFileSync(path.join(__dirname, "recorder-script.js"), "utf8");

const PROTOCOL = "proofline-recorder";
const BACKGROUND_FLAG = "--background";

// Login autostart (Windows/macOS): the OS launches us without the flag, but the
// login-item settings report it — treat that as a background launch too.
const launchedAtLogin = (() => {
  try { return app.getLoginItemSettings().wasOpenedAtLogin; } catch { return false; }
})();
const backgroundLaunch = process.argv.includes(BACKGROUND_FLAG) || launchedAtLogin;

// Linux AppImages cannot preserve chrome-sandbox's setuid bit inside the squashfs
// mount, and Chromium aborts instead of falling back when the file exists with wrong
// permissions. The recorder only renders pages the user chooses to record, so the
// SUID sandbox is disabled there; Windows/macOS keep their native sandboxes.
if (process.platform === "linux") app.commandLine.appendSwitch("no-sandbox");

// Dev machines can't set the SUID sandbox helper (needs root). Packaged installers
// configure Chromium's sandbox correctly, so this only applies to source runs.
if (!app.isPackaged) app.commandLine.appendSwitch("no-sandbox");
const PUSH_INTERVAL_MS = 2000;
const SCREENSHOT_EVERY_PUSHES = 3; // ~6s between pushed screenshots

/**
 * One-time (and self-healing) Linux installation, re-run on every launch:
 *  1. Copies the AppImage to a stable home (Downloads paths get cleaned up).
 *  2. Registers proofline-recorder:// with the desktop environment.
 *  3. Adds an autostart entry so the recorder is resident from login onwards.
 * After the user runs the AppImage once, recordings launch with a single click.
 */
/**
 * Idempotently ensures `x-scheme-handler/proofline-recorder=proofline-recorder.desktop`
 * exists under [Default Applications] (and [Added Associations]) in a mimeapps.list
 * file, creating the file/sections as needed without disturbing other entries.
 */
function addMimeappsAssociation(file) {
  try {
    const line = "x-scheme-handler/proofline-recorder=proofline-recorder.desktop";
    let content = "";
    try { content = readFileSync(file, "utf8"); } catch {}
    if (content.includes(line)) return;
    const section = (names) => {
      for (const name of names) {
        const marker = `[${name}]`;
        if (content.includes(marker)) return marker;
      }
      return null;
    };
    const target = section(["Default Applications", "Added Associations"]);
    if (target) {
      content = content.replace(target, `${target}\n${line}`);
    } else {
      content = content.trimEnd() + (content.trim() ? "\n\n" : "") + "[Default Applications]\n" + line + "\n";
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  } catch (error) {
    console.error(`[recorder] mimeapps update failed (${file}):`, error.message);
  }
}

function installLinuxIntegration(appImagePath) {
  try {
    const home = homedir();
    const stableDir = path.join(home, ".local", "share", "proofline-recorder");
    const stableApp = path.join(stableDir, "ProoflineRecorder.AppImage");

    let execPath = appImagePath;
    try {
      mkdirSync(stableDir, { recursive: true });
      let needsCopy = true;
      try { needsCopy = statSync(appImagePath).size !== statSync(stableApp).size; } catch {}
      if (appImagePath !== stableApp && needsCopy) {
        copyFileSync(appImagePath, stableApp);
        chmodSync(stableApp, 0o755);
        console.log(`[recorder] installed to ${stableApp}`);
      }
      if (existsSync(stableApp)) execPath = stableApp;
    } catch (error) {
      console.error("[recorder] stable install failed:", error.message);
    }

    const appsDir = path.join(home, ".local", "share", "applications");
    mkdirSync(appsDir, { recursive: true });
    const entry = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Proofline Recorder",
      `Exec=${execPath} %u`,
      "MimeType=x-scheme-handler/proofline-recorder;",
      "Terminal=false",
      "NoDisplay=true"
    ].join("\n");
    writeFileSync(path.join(appsDir, "proofline-recorder.desktop"), entry + "\n");
    execSync("xdg-mime default proofline-recorder.desktop x-scheme-handler/proofline-recorder", { stdio: "ignore" });
    // Modern DEs read ~/.config/mimeapps.list (written by xdg-mime above), but KDE,
    // XFCE, older distros and some sandboxed browsers consult the legacy
    // ~/.local/share/applications/mimeapps.list instead — register in BOTH so the
    // protocol resolves on any Linux system.
    addMimeappsAssociation(path.join(appsDir, "mimeapps.list"));
    addMimeappsAssociation(path.join(home, ".config", "mimeapps.list"));
    try { execSync(`update-desktop-database ${appsDir}`, { stdio: "ignore" }); } catch {}

    const autostartDir = path.join(home, ".config", "autostart");
    mkdirSync(autostartDir, { recursive: true });
    writeFileSync(path.join(autostartDir, "proofline-recorder.desktop"), [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Proofline Recorder",
      `Exec=${execPath} ${BACKGROUND_FLAG}`,
      "Terminal=false",
      "NoDisplay=true"
    ].join("\n") + "\n");

    console.log(`[recorder] installed: handler=${execPath}, protocol registered, autostart enabled`);
  } catch (error) {
    console.error("[recorder] install failed:", error.message);
  }
}

let mainWindow = null; // the app's own window is hidden; recording windows carry the UI
let session = null; // { id, project, api, token, target, win, events, pushTimer, pushCount, ended }
let statusWindow = null;
let quitting = false;

ipcMain.on("quit-app", () => app.quit());
app.on("before-quit", () => { quitting = true; });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Install-once integration: on Linux the AppImage self-installs (stable copy +
  // protocol registration + autostart at login) on every launch, so a single run
  // after download is all the setup a user ever does. Windows/macOS register the
  // protocol via their installers and enable login-item autostart here.
  if (process.env.APPIMAGE) {
    installLinuxIntegration(process.env.APPIMAGE);
  } else if (app.isPackaged) {
    app.setAsDefaultProtocolClient(PROTOCOL);
    if (process.platform === "win32" || process.platform === "darwin") {
      // Start hidden at login so the recorder is always resident and recordings
      // open instantly after a reboot. Windows passes --background via args;
      // macOS launches are detected via getLoginItemSettings().wasOpenedAtLogin.
      try { app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: [BACKGROUND_FLAG] }); } catch {}
    }
  } else {
    const appPath = path.resolve(process.argv[1] ?? ".");
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [appPath]);
  }

  // Windows/Linux: deep links arrive as argv in the second instance.
  app.on("second-instance", (_event, argv) => {
    const link = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (link) handleDeepLink(link);
  });
  // macOS: deep links arrive here (cold start) …
  app.on("open-url", (event, url) => {
    event.preventDefault();
    app.whenReady().then(() => handleDeepLink(url));
  });

  app.whenReady().then(() => {
    startPresenceServer();
    // Windows/Linux cold start: the deep link is the last argv entry.
    const link = process.argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (link) handleDeepLink(link);
    // Background (login autostart / --background): stay resident silently, no window.
    else if (!backgroundLaunch) createStatusWindow();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0 && !session && !backgroundLaunch) createStatusWindow(); });
  });

  app.on("window-all-closed", () => {
    // Stay resident so the next "Record steps" deep link launches instantly.
  });
}

/**
 * Loopback presence endpoint. The web app's setup modal probes this to detect that the
 * recorder is installed and running on this machine — in real time, from any origin
 * (including the HTTPS production site: loopback is mixed-content-exempt, and the
 * OPTIONS preflight answers Chrome's Private Network Access requirements).
 */
const PRESENCE_PORT = 43117;

function startPresenceServer() {
  const server = http.createServer((request, response) => {
    // CORS for any origin (the web app may be localhost or the production domain).
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // Chrome Private Network Access: public HTTPS pages must be allowed to reach us.
    response.setHeader("Access-Control-Allow-Private-Network", "true");
    response.setHeader("Access-Control-Max-Age", "86400");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url.split("?")[0] === "/ping") {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(200);
      response.end(JSON.stringify({ app: PROTOCOL, version: app.getVersion(), running: true }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on("error", (error) => {
    // A resident instance already serving the port is fine; anything else is non-fatal.
    console.error("[recorder] presence server:", error.code ?? error.message);
  });
  server.listen(PRESENCE_PORT, "127.0.0.1", () => {
    console.log(`[recorder] presence endpoint on http://127.0.0.1:${PRESENCE_PORT}/ping`);
  });
}

const STATUS_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font-family: system-ui, sans-serif; background: #0f1418; color: #d7e2dc; padding: 22px; }
  h3 { margin: 0 0 10px; }
  p { margin: 0 0 14px; font-size: 13px; line-height: 1.6; color: #9fb3ab; }
  button { border: 0; background: #1f7265; color: #fff; padding: 8px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; }
</style></head><body>
<h3>Proofline Recorder is running</h3>
<p>Start a recording from the web app (Test cases → Record steps in a browser) — the app you are recording will open in a new window. Keep this app running while you record.</p>
<button onclick="require('electron').ipcRenderer.send('quit-app')">Quit Proofline Recorder</button>
</body></html>`;

function createStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) { statusWindow.focus(); return; }
  statusWindow = new BrowserWindow({
    width: 440,
    height: 240,
    resizable: false,
    title: "Proofline Recorder",
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  statusWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(STATUS_HTML));
  statusWindow.on("closed", () => { statusWindow = null; });
}

function parseDeepLink(link) {
  try {
    const url = new URL(link);
    const sessionId = url.searchParams.get("session");
    const token = url.searchParams.get("token");
    const api = url.searchParams.get("api");
    const target = url.searchParams.get("target");
    const project = url.searchParams.get("project");
    if (!sessionId || !token || !api || !target || !project) return null;
    return { sessionId, token, api: api.replace(/\/+$/, ""), target, project };
  } catch {
    return null;
  }
}

function handleDeepLink(link) {
  // The deep-link host names the action: record?… (recording session) or uninstall.
  let action = "";
  try { action = new URL(link).host; } catch {}
  if (action === "uninstall") {
    uninstallRecorder();
    return;
  }
  const parsed = parseDeepLink(link);
  if (!parsed) {
    console.error("[recorder] ignoring malformed deep link:", String(link).slice(0, 120));
    return;
  }
  startRecording(parsed).catch((error) => console.error("[recorder] start failed:", error.message));
}

/** Removes the protocol registration, autostart entry, and stable copy created by
 *  the install. Deleting the running AppImage is safe on Linux (unlink + exit). */
function uninstallRecorder() {
  try {
    if (process.env.APPIMAGE) {
      const home = homedir();
      const artifacts = [
        path.join(home, ".local", "share", "applications", "proofline-recorder.desktop"),
        path.join(home, ".config", "autostart", "proofline-recorder.desktop")
      ];
      for (const file of [path.join(home, ".local", "share", "applications", "mimeapps.list"), path.join(home, ".config", "mimeapps.list")]) {
        try {
          const lines = readFileSync(file, "utf8").split("\n").filter((line) => !line.startsWith("x-scheme-handler/proofline-recorder="));
          writeFileSync(file, lines.join("\n"));
        } catch {}
      }
      for (const artifact of artifacts) { try { rmSync(artifact, { force: true }); } catch {} }
      try { rmSync(path.join(home, ".local", "share", "proofline-recorder"), { recursive: true, force: true }); } catch {}
      try { execSync(`update-desktop-database ${path.join(home, ".local", "share", "applications")}`, { stdio: "ignore" }); } catch {}
    } else if (app.isPackaged) {
      try { app.removeAsDefaultProtocolClient(PROTOCOL); } catch {}
      if (process.platform === "win32" || process.platform === "darwin") {
        try { app.setLoginItemSettings({ openAtLogin: false }); } catch {}
      }
    }
    console.log("[recorder] uninstalled: registration, autostart, and app files removed");
    showNoticeWindow("Proofline Recorder uninstalled", "Proofline Recorder has been removed from this computer. This window closes shortly.");
    setTimeout(() => app.quit(), 6000);
  } catch (error) {
    console.error("[recorder] uninstall failed:", error.message);
  }
}

/** Small transient message window (used by the uninstall confirmation). */
function showNoticeWindow(title, message) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: system-ui, sans-serif; background: #0f1418; color: #d7e2dc; padding: 26px; }
    h3 { margin: 0 0 10px; } p { margin: 0; font-size: 13px; line-height: 1.6; color: #9fb3ab; }
  </style></head><body><h3>${title}</h3><p>${message}</p></body></html>`;
  const win = new BrowserWindow({ width: 420, height: 190, resizable: false, title, autoHideMenuBar: true });
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  win.on("page-title-updated", (event) => event.preventDefault());
}

async function startRecording(parsed) {
  // A new deep link while recording: stop the old session first, then start fresh.
  if (session) await endSession(session, false);

  session = {
    ...parsed,
    events: [],
    pushTimer: null,
    pushCount: 0,
    ended: false
  };

  session.win = createRecordingWindow(session);
  // The status window's job is done once a recording opens.
  if (statusWindow && !statusWindow.isDestroyed()) statusWindow.close();
  await session.win.loadURL(session.target);

  await fetchJson(`${session.api}/v1/projects/${session.project}/recordings/${session.sessionId}/attach`, session.token, { method: "POST" });

  session.pushTimer = setInterval(() => void pushEvents(session), PUSH_INTERVAL_MS);
  console.log(`[recorder] recording ${session.sessionId} → ${session.target}`);
}

function createRecordingWindow(rec) {
  const win = new BrowserWindow({
    width: 1366,
    height: 900,
    title: `Proofline Recorder — ${rec.target}`,
    autoHideMenuBar: true
  });
  // Registered BEFORE loadURL — did-finish-load has already fired by the time
  // loadURL resolves, so a late handler would never inject the capture script.
  // It also re-injects after every full navigation.
  win.webContents.on("did-finish-load", () => {
    win.webContents.executeJavaScript(RECORDER_SCRIPT).catch(() => undefined);
  });
  win.on("page-title-updated", (event) => event.preventDefault());
  win.on("closed", () => {
    // Closing the recorded page ends only the local window. The platform session stays
    // open so the web UI keeps its "Stop Recording" control — the user stops (and
    // imports) from there. No status window is spawned; the app stays resident silently.
    if (session && session.win === win && !session.ended) void endSession(session, false);
  });
  return win;
}

async function pushEvents(rec) {
  if (rec.ended || rec.win?.isDestroyed()) return;
  try {
    const taken = await rec.win.webContents.executeJavaScript("window.__prooflineTakeEvents ? window.__prooflineTakeEvents() : []");
    rec.events.push(...taken);
    // Drop consecutive duplicates (same action + same target), matching the platform's rule.
    rec.events = rec.events.filter((event, index) => index === 0 || event.action !== rec.events[index - 1].action || event.target !== rec.events[index - 1].target);

    rec.pushCount += 1;
    const body = { events: rec.events };
    if (rec.pushCount % SCREENSHOT_EVERY_PUSHES === 0) {
      const image = await rec.win.webContents.capturePage();
      body.screenshot = image.toDataURL("image/jpeg", 0.5);
    }
    await fetchJson(`${rec.api}/v1/projects/${rec.project}/recordings/${rec.sessionId}/events`, rec.token, { method: "PUT", body });
    rec.win.setTitle(`Proofline Recorder — recording (${rec.events.length} steps)`);
  } catch (error) {
    const message = error.message || "";
    if (message.includes("already ended") || message.includes("not found")) {
      console.log("[recorder] session ended on the platform — stopping.");
      await endSession(rec, false);
    } else {
      console.error("[recorder] push failed:", message.slice(0, 200));
    }
  }
}

  async function endSession(rec, callStop) {
    if (rec.ended) return;
    rec.ended = true;
    if (rec.pushTimer) clearInterval(rec.pushTimer);
    if (callStop) {
      try { await fetchJson(`${rec.api}/v1/projects/${rec.project}/recordings/${rec.sessionId}/stop`, rec.token, { method: "POST", body: { events: rec.events } }); } catch {}
    }
    if (rec.win && !rec.win.isDestroyed()) rec.win.close();
    if (session === rec) session = null;
    // Stay resident silently — no status window here. Popping one after the user
    // closed the recording window forces an extra "Quit" step they didn't ask for.
    console.log("[recorder] session ended.");
  }

async function fetchJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message ?? `Request failed with status ${response.status}`);
  }
  return response.json().catch(() => ({}));
}
