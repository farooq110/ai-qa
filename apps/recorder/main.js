const { app, BrowserWindow, ipcMain } = require("electron");
const http = require("node:http");
const { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, statSync, existsSync, rmSync, readdirSync } = require("node:fs");
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

// Linux compatibility: minimal distros ship without the SUID chrome-sandbox helper,
// GPU drivers (e.g. NVIDIA) may be missing or incompatible, and software
// rasterization can crash on stripped-down systems. These switches keep Chromium
// launching reliably across all Linux distributions — with or without a GPU.
// Video-acceleration paths are disabled too: the VA-API probe dlopens the system
// libva/Intel driver and prints "libva error: … init failed" on machines without
// an Intel GPU (harmless, but noisy). The recorder records DOM events — it never
// needs hardware video decode — so the whole VA-API stack is switched off and the
// app stays self-contained (no system library dependencies).
// Windows/macOS keep their native sandboxes and GPU acceleration.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-accelerated-video-decode");
  app.commandLine.appendSwitch("disable-features", "VaapiVideoDecodeLinuxGL,VaapiVideoEncoder,VaapiIgnoreDriverChecks");
}

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
 * The default-handler lookup (xdg-settings / GLib / Firefox) only respects
 * [Default Applications], so the entry ALWAYS lands there — [Added Associations]
 * merely feeds "Open with…" lists, so it is mirrored there too when present.
 */
function addMimeappsAssociation(file) {
  try {
    const line = "x-scheme-handler/proofline-recorder=proofline-recorder.desktop";
    let content = "";
    try { content = readFileSync(file, "utf8"); } catch {}
    if (content.includes(line)) return;
    const ensureInSection = (content, sectionName) => {
      const marker = `[${sectionName}]`;
      if (content.includes(marker)) {
        return content.replace(marker, `${marker}\n${line}`);
      }
      return content.trimEnd() + (content.trim() ? "\n\n" : "") + marker + "\n" + line + "\n";
    };
    content = ensureInSection(content, "Default Applications");
    if (content.includes("[Added Associations]")) {
      content = content.replace("[Added Associations]", `[Added Associations]\n${line}`);
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  } catch (error) {
    console.error(`[recorder] mimeapps update failed (${file}):`, error.message);
  }
}

/**
 * Idempotently maintains the `x-scheme-handler/proofline-recorder` entry in the
 * applications directory's mimeinfo.cache — the same file `update-desktop-database`
 * would produce. Replicating it with a plain file write keeps the app fully
 * self-contained (no external tools on minimal Linux) while desktop environments
 * and browsers that consult the cache still resolve the handler name.
 */
function updateMimeinfoCache(appsDir, remove) {
  try {
    const file = path.join(appsDir, "mimeinfo.cache");
    const entry = `x-scheme-handler/proofline-recorder=proofline-recorder.desktop`;
    let content = "";
    try { content = readFileSync(file, "utf8"); } catch {}
    let lines = content.split("\n");
    lines = lines.filter((line) => line.trim() !== entry);
    if (!remove) {
      const marker = "[MIME Cache]";
      const index = lines.findIndex((line) => line.trim() === marker);
      if (index >= 0) lines.splice(index + 1, 0, entry);
      else lines = [...(content.trim() ? lines.filter((line) => line.trim() !== "") : []), marker, entry];
    }
    let out = lines.filter((line, index) => line !== "" || index < lines.length - 1).join("\n");
    if (!out.endsWith("\n")) out += "\n";
    mkdirSync(appsDir, { recursive: true });
    writeFileSync(file, out);
  } catch (error) {
    console.error("[recorder] mimeinfo.cache update failed:", error.message);
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
    // Protocol registration is done purely through direct file writes — no external
    // tools (xdg-mime / update-desktop-database / xdg-settings) are invoked, so the
    // app stays fully self-contained and never breaks on minimal Linux systems that
    // lack the xdg-utils package. Modern DEs read ~/.config/mimeapps.list, but KDE,
    // XFCE, older distros and some sandboxed browsers consult the legacy
    // ~/.local/share/applications/mimeapps.list instead — write BOTH so the protocol
    // resolves on any Linux system. mimeinfo.cache (below) completes the set.
    addMimeappsAssociation(path.join(appsDir, "mimeapps.list"));
    addMimeappsAssociation(path.join(home, ".config", "mimeapps.list"));
    updateMimeinfoCache(appsDir, false);

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

/**
 * Loopback presence endpoint — the web app's live "is the recorder installed and
 * running RIGHT NOW" check, probed from any origin (loopback is
 * mixed-content-exempt; the OPTIONS preflight answers Chrome's Private Network
 * Access and Local Network Access requirements).
 *
 * Robustness rules learned from net::ERR_CONNECTION_REFUSED field reports:
 *  - Bind BOTH loopback stacks. Browsers spell the host as "localhost", which
 *    can resolve to ::1 first (or only) on some Linux setups; an IPv4-only
 *    listener then REFUSES those connections. Serving on 127.0.0.1 AND ::1
 *    makes every host spelling connect.
 *  - Bind the moment the single-instance lock is acquired — before any window,
 *    before GPU init — so the endpoint answers within milliseconds of the
 *    install command launching the app, even if window/GUI startup later hangs.
 *  - /ping reports the app version and pid, so the browser UI (and the terminal
 *    log) can confirm exactly WHICH build is answering — an outdated AppImage
 *    is instantly identifiable instead of failing silently.
 */
const PRESENCE_PORT = 43117;
const PRESENCE_HOSTS = ["127.0.0.1", "::1"];

function presencePayload() {
  return { app: PROTOCOL, version: app.getVersion(), pid: process.pid, running: true };
}

function handlePresenceRequest(request, response) {
  // CORS for any origin (the web app may be localhost or the production domain).
  // Echoing whatever headers the preflight asks about keeps the handshake valid
  // across browsers; the fallback covers plain (non-preflight) requests.
  const requestedHeaders = request.headers["access-control-request-headers"];
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", Array.isArray(requestedHeaders) ? requestedHeaders.join(", ") : (requestedHeaders ?? "Content-Type"));
  // A public HTTPS page probing loopback passes through Chrome's Private Network
  // Access gate (older Chrome) and its Local Network Access successor (Chrome
  // 142+) — answering BOTH opt-in headers keeps the /ping probe allowed on every
  // Chrome generation; browsers that don't know a header simply ignore it.
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Access-Control-Allow-Non-Local-Network", "true");
  response.setHeader("Access-Control-Max-Age", "86400");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  const requestPath = request.url.split("?")[0];
  // Browser-friendly uninstall: the web app POSTs here instead of navigating to
  // proofline-recorder://uninstall, which made Chrome show its "Open xdg-open?"
  // confirmation and (with no handler registered) a "No App Available" dialog.
  // The response is flushed BEFORE the uninstall starts — the app quits shortly
  // after, and the browser must not see a failed request.
  if (request.method === "POST" && requestPath === "/uninstall") {
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(JSON.stringify({ ok: true, app: PROTOCOL, version: app.getVersion(), uninstalling: true }));
    const run = () => { void stopAndUninstall(); };
    if (typeof response.on === "function") response.on("finish", () => setTimeout(run, 250));
    else setTimeout(run, 500);
    return;
  }
  if ((request.method === "GET" || request.method === "HEAD") && (requestPath === "/ping" || requestPath === "/")) {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "HEAD") {
      response.writeHead(200);
      response.end();
      return;
    }
    response.writeHead(200);
    response.end(JSON.stringify(presencePayload()));
    return;
  }
  response.writeHead(404);
  response.end();
}

/** One listener per loopback host. EADDRINUSE = a resident instance is already
 *  serving (harmless — that instance keeps the endpoint up); EAFNOSUPPORT = this
 *  machine has no such network stack (skip it, the other stack still serves);
 *  anything else gets one self-healing retry after a second. */
function startPresenceListener(host, retriesLeft = 1) {
  const display = host === "::1" ? "[::1]" : host;
  const server = http.createServer(handlePresenceRequest);
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`[recorder] presence server on ${display}: EADDRINUSE — the resident instance keeps serving`);
      return;
    }
    if (error.code === "EAFNOSUPPORT") {
      console.error(`[recorder] presence server: ${display} not available on this machine — skipped`);
      return;
    }
    if (retriesLeft > 0) {
      console.error(`[recorder] presence server on ${display}: ${error.code ?? error.message} — retrying in 1s`);
      setTimeout(() => startPresenceListener(host, retriesLeft - 1), 1000);
      return;
    }
    console.error(`[recorder] presence server on ${display}: ${error.code ?? error.message}`);
  });
  server.listen(PRESENCE_PORT, host, () => {
    console.log(`[recorder] presence endpoint on http://${display}:${PRESENCE_PORT}/ping`);
  });
}

function startPresenceServer() {
  for (const host of PRESENCE_HOSTS) startPresenceListener(host);
}

/** Is our own endpoint answering on either loopback stack? Timeout-bound, never
 *  throws — used by the lock-denied path to tell a healthy resident instance
 *  from a hung/outdated one that holds the lock but serves nothing. */
function probeOwnEndpoint(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let pending = PRESENCE_HOSTS.length;
    const done = (ok) => {
      if (settled) return;
      if (ok) { settled = true; resolve(true); }
      else if (--pending === 0) { settled = true; resolve(false); }
    };
    for (const host of PRESENCE_HOSTS) {
      const req = http.get({ host, port: PRESENCE_PORT, path: "/ping" }, (res) => {
        res.resume();
        done(res.statusCode === 200);
      });
      req.on("timeout", () => { req.destroy(); done(false); });
      req.on("error", () => done(false));
      req.setTimeout(timeoutMs);
    }
  });
}

/** Linux: pids of OTHER Proofline Recorder processes (downloaded AppImage run,
 *  stable-home run, or protocol deep-link launch), identified strictly by /proc
 *  cmdline contents — never by fuzzy name matching, so unrelated processes are
 *  never touched. Empty on non-Linux or when nothing matches. */
function findRecorderProcesses() {
  const found = [];
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid) continue;
      try {
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
        if (cmdline.includes("ProoflineRecorder.AppImage") || cmdline.includes("proofline-recorder")) found.push(pid);
      } catch {} // process exited between readdir and read — ignore
    }
  } catch {}
  return found;
}

/** Waits (bounded) until every pid is gone. `process.kill(pid, 0)` is the classic
 *  existence probe — signal 0 is delivered as nothing at all. */
function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const alive = pids.some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
      if (!alive || Date.now() >= deadline) resolve(!alive);
      else setTimeout(tick, 150);
    };
    tick();
  });
}

ipcMain.on("quit-app", () => app.quit());
app.on("before-quit", () => { quitting = true; });

// The very first line in the terminal: which build is starting. When several
// builds of the recorder coexist on a machine (downloaded AppImage vs. registered
// stable copy), this line and the /ping version answer remove all guesswork.
console.log(`[recorder] Proofline Recorder ${app.getVersion()} (pid ${process.pid}) starting`);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // One process per machine: the lock owner is THE recorder. Every later launch
  // either finds it healthy — serving /ping — and exits quietly, or, when the
  // lock holder is an outdated/hung build that never bound the port (the exact
  // state behind net::ERR_CONNECTION_REFUSED in the browser), takes over:
  // terminate it and relaunch this build, which binds the endpoint immediately.
  void probeOwnEndpoint(400).then((serving) => {
    if (serving) {
      console.log(`[recorder] another instance is already running and serving http://127.0.0.1:${PRESENCE_PORT}/ping — this launch exits; the running one keeps the presence endpoint up`);
      app.quit();
      return;
    }
    if (process.platform !== "linux") {
      console.log("[recorder] another instance is already running but is not serving — this launch exits. Quit it from its window/tray and start this build again.");
      app.quit();
      return;
    }
    const stale = findRecorderProcesses();
    if (stale.length === 0) {
      console.log(`[recorder] lock is held but nothing is serving port ${PRESENCE_PORT} and no recorder process was found — exiting. If detection still fails, run: pkill -f ProoflineRecorder ; ./ProoflineRecorder.AppImage`);
      app.quit();
      return;
    }
    console.log(`[recorder] lock holder (pid ${stale.join(", ")}) is not serving port ${PRESENCE_PORT} — an outdated or hung build. Taking over...`);
    for (const pid of stale) { try { process.kill(pid, "SIGTERM"); } catch {} }
    void waitForExit(stale, 3000).then((exited) => {
      if (!exited) for (const pid of stale) { try { process.kill(pid, "SIGKILL"); } catch {} }
      console.log("[recorder] stale instance terminated — relaunching this build");
      try { app.relaunch(); } catch {}
      app.quit();
    });
  });
} else {
  // Serve /ping from the earliest possible moment — before windows, before GPU init
  // — so the web app detects the recorder the instant the install command starts
  // it ("chmod +x … && ./ProoflineRecorder.AppImage"), with no manual launch, no
  // recording, and no recorder window required.
  startPresenceServer();

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
    // Windows/Linux cold start: the deep link is the last argv entry.
    // (The presence endpoint is already up — started at lock acquisition above.)
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
 * Loopback presence endpoint — defined and started above, at lock acquisition.
 */

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
    void stopAndUninstall(false);
    return;
  }
  const parsed = parseDeepLink(link);
  if (!parsed) {
    console.error("[recorder] ignoring malformed deep link:", String(link).slice(0, 120));
    return;
  }
  startRecording(parsed).catch((error) => console.error("[recorder] start failed:", error.message));
}

/** Stops any active recording session, then removes the protocol registration,
 *  autostart entry, and stable copy created by the install. Deleting the running
 *  AppImage is safe on Linux (unlink + exit). The `silent` variant (HTTP
 *  uninstall) skips the notice window and quits fast — the web UI already shows
 *  the outcome inline. */
async function stopAndUninstall(silent = true) {
  if (session && !session.ended) { try { await endSession(session, false); } catch {} }
  uninstallRecorder(silent);
}

function uninstallRecorder(silent = false) {
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
      updateMimeinfoCache(path.join(home, ".local", "share", "applications"), true);
    } else if (app.isPackaged) {
      try { app.removeAsDefaultProtocolClient(PROTOCOL); } catch {}
      if (process.platform === "win32" || process.platform === "darwin") {
        try { app.setLoginItemSettings({ openAtLogin: false }); } catch {}
      }
    }
    console.log("[recorder] uninstalled: registration, autostart, and app files removed");
    if (!silent) showNoticeWindow("Proofline Recorder uninstalled", "Proofline Recorder has been removed from this computer. This window closes shortly.");
    setTimeout(() => app.quit(), silent ? 800 : 6000);
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
