# Proofline Recorder — Build & Debug Guide

Build steps for the three desktop targets (Linux AppImage, Windows installer, macOS DMG)
plus debugging procedures for development and production. Everything below matches the
actual build configuration in `apps/recorder/package.json` and the scripts in this folder.

> **⚠ Read this before wondering why a code fix "didn't work":**
> The API serves the recorder from the **built artifact** — `apps/recorder/dist/ProoflineRecorder.AppImage`
> (or S3 in production). Editing `apps/recorder/main.js` (or any recorder source file) changes **nothing**
> on machines that run a previously built AppImage until you **rebuild** it:
>
> ```bash
> cd apps/recorder && pnpm dist --linux AppImage      # or: ./apps/recorder/scripts/build-linux.sh
> chmod +x dist/ProoflineRecorder.AppImage && ./dist/ProoflineRecorder.AppImage
> ```
>
> The fresh run re-registers itself (the stable copy under `~/.local/share/proofline-recorder/`
> is overwritten automatically) and, if an old instance is still holding the single-instance
> lock while not serving `/ping`, the new build **takes over** — it terminates the stale process
> and relaunches itself. Verify with `curl http://127.0.0.1:43117/ping` — the `version` field
> must show the version from `apps/recorder/package.json` (current: **1.2.0**).

---

## 0. `pnpm dev` and the recorder

**The recorder never starts with the development server.** Root `pnpm dev` runs
`turbo run dev --parallel` across the workspace, and the recorder package deliberately
ships **no `dev` script** — so nothing Electron-related launches when you develop the
web app / API / workers. The recorder starts only when the user has installed it and
explicitly launches it:

```bash
pnpm --filter @ai-qa/recorder start      # from the repo root (manual dev run)
# or: cd apps/recorder && pnpm start
```

---

## 1. Prerequisites (all platforms)

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20+ | Docker build uses Node 22 |
| pnpm | 10.30.1 | Repo pins it via corepack: `corepack enable && corepack prepare pnpm@10.30.1 --activate` |
| OS for building | see per-platform | Linux/macOS build → Docker script or local; Windows build → Docker cross-build script (Linux host) or a Windows machine; macOS build → Mac required |

Install recorder dependencies from the **repo root** (it is a pnpm workspace):

```bash
corepack enable
pnpm install --filter @ai-qa/recorder...
```

Key facts about the build config (`apps/recorder/package.json` → `build` section):

- **appId:** `com.prooflineqa.recorder`, **productName:** `Proofline Recorder`
- **Linux:** AppImage → `dist/ProoflineRecorder.AppImage`
- **Windows:** NSIS one-click, per-user → `dist/ProoflineRecorder-Setup.exe`
- **macOS:** DMG → `dist/ProoflineRecorder.dmg`
- **afterPack hook:** `scripts/remove-chrome-sandbox.js` — Linux only (no-op on Win/Mac).
  Removes the SUID `chrome-sandbox`, then wraps the main binary in a launcher that adds
  `--no-sandbox`, checks for missing shared libraries with a readable error message, and
  silences harmless libva probe noise (`LIBVA_MESSAGING_LEVEL=0`).
- **Deep-link protocol:** `proofline-recorder://` registered by the app itself at runtime
  through pure file writes (no external tools — see section 3).
- **Version:** artifacts embed `version` from `apps/recorder/package.json` — bump it before
  releasing so `/ping` and update checks report the right value.

---

## 2. Run in development

```bash
pnpm --filter @ai-qa/recorder start
# (cd apps/recorder && pnpm start works too — there is no `dev` script by design:
#  root `pnpm dev` must never launch the recorder)
```

What you should see within a second or two:

1. A small **status window** ("Proofline Recorder is running").
2. Terminal lines:
   - `[recorder] Proofline Recorder 1.2.0 (pid …) starting`
   - `[recorder] presence endpoint on http://127.0.0.1:43117/ping`
   - `[recorder] presence endpoint on http://[::1]:43117/ping`

Quick health check (from another terminal):

```bash
curl http://127.0.0.1:43117/ping
curl http://[::1]:43117/ping       # IPv6 loopback — must answer too
# {"app":"proofline-recorder","version":"1.2.0","pid":12345,"running":true}
```

The web app's setup modal **and the whole Test Cases page** probe that same `/ping` URL
with **exponential backoff**: the first check runs 2 seconds after the test editor opens
(nothing fires the moment a modal opens), every unsuccessful check doubles the wait
(4s, 8s, capped at **10 seconds** forever), and the moment a recorder answers, polling
**stops immediately** — no further requests while it stays installed. The modal's
**Check again** button probes on demand (user gesture), and its **Uninstall** button asks
the running recorder to stop and remove itself over `POST /uninstall` on the same endpoint
(no browser protocol dialog). When the app is installed and running:

- "Record steps in a browser" becomes enabled (it stays disabled before that),
- the Recorder Setup modal shows the green "Installed on this computer" check,
- all download buttons in the modal disable.

If `curl` works in dev but the web page never detects the recorder, the problem is
browser-side (see the detection troubleshooting row in section 7), not the recorder.

### GPU modes (hardware acceleration vs. software fallback)

The recorder renders whatever sites the user records — including heavy WebGL / 3D
pages — so **hardware acceleration is fully ON by default on every platform**:
`main.js` appends `--enable-gpu` and `--ignore-gpu-blocklist` before the app is ready
(Chromium reads these once, at GPU-process startup). `--ignore-gpu-blocklist` matters
most on Linux, where Chromium's conservative driver blocklist otherwise forces many
capable NVIDIA/AMD/VM GPUs into software rendering — which broke GPU-heavy pages in
older builds (they disabled the GPU entirely, plus the software rasterizer).

For troubleshooting — headless boxes, VMs without 3D, or a machine where the GPU
driver misbehaves — launch with the fallback flag to force software rendering
(SwiftShader stays available, so pages still draw):

```bash
./ProoflineRecorder.AppImage --disable-gpu-mode          # Linux
"C:/Users/<you>/AppData/Local/Proofline Recorder/Proofline Recorder.exe" --disable-gpu-mode   # Windows
```

In that mode the app appends `--disable-gpu` (plus disables hardware video decode and
the VA-API stack, which are pointless without a GPU). The active mode is logged at
startup (`[recorder] GPU: hardware acceleration enabled (default)` or `… software
rendering requested via --disable-gpu-mode`), and if the GPU process ever dies at
runtime, a `[recorder] GPU process gone (…)` line explains why Chromium fell back to
software. Linux safety switches are unaffected: `--no-sandbox` is still appended on
Linux (and by the packaged launcher), keeping universal-distro startup behavior intact.

---

## 3. Building Linux AppImage

### Option A — Quick local build (good for your own machine)

Build on any Linux box with Node + pnpm:

```bash
cd apps/recorder
pnpm dist --linux AppImage
# → dist/ProoflineRecorder.AppImage
```

**Caveat:** the binary links against the *host's* glibc. If you build on Ubuntu 24.04,
the AppImage may refuse to start on older distros with `version 'GLIBC_2.3x' not found`.

### Option B — Docker baseline build (recommended, portable)

This is what `scripts/build-linux.sh` does — it builds inside **Debian 11 (glibc 2.31)**
so the AppImage runs on every mainstream distro (Ubuntu 20.04+, Debian 11+, Fedora 34+,
Arch, RHEL 9 — anything with glibc ≥ 2.31):

```bash
# from the repo root, requires Docker
./apps/recorder/scripts/build-linux.sh
# → apps/recorder/dist/ProoflineRecorder.AppImage
# optional: ./apps/recorder/scripts/build-linux.sh /path/to/output-dir
```

What happens under the hood (`infrastructure/docker/recorder-build.Dockerfile`):
installs deps with a frozen lockfile, runs `electron-builder --linux AppImage`, then the
afterPack hook hardens the result (sandbox removal + `--no-sandbox` launcher + missing
library detection + libva silencing).

### How protocol registration works (self-contained, no external tools)

The app never shells out to `xdg-mime`, `xdg-settings`, or `update-desktop-database` —
minimal Linux systems lack these and older builds crashed on them. Instead, every launch
writes the complete registration set directly:

| File | Purpose |
|---|---|
| `~/.local/share/applications/proofline-recorder.desktop` | handler entry (`Name=Proofline Recorder`, `MimeType=x-scheme-handler/proofline-recorder;`) — what browsers/DEs read to display the app name |
| `~/.config/mimeapps.list` → `[Default Applications]` | default handler for the scheme (also mirrored under `[Added Associations]` when present) |
| `~/.local/share/applications/mimeapps.list` → `[Default Applications]` | same, legacy location used by KDE/XFCE/older distros |
| `~/.local/share/applications/mimeinfo.cache` → `[MIME Cache]` | what `update-desktop-database` would produce — completes the lookup set |
| `~/.config/autostart/proofline-recorder.desktop` | login autostart (`--background`) |
| `~/.local/share/proofline-recorder/ProoflineRecorder.AppImage` | stable copy (re-pointed from Downloads) |

All writes are idempotent and merge-preserving — pre-existing entries are never touched.

### Verify a Linux build

```bash
cd apps/recorder/dist
chmod +x ProoflineRecorder.AppImage
./ProoflineRecorder.AppImage          # status window appears
curl http://127.0.0.1:43117/ping      # running:true, version must match package.json
curl http://[::1]:43117/ping          # IPv6 loopback answers too
```

Then check the self-install artifacts (created on first run — see the table above):

```bash
ls ~/.local/share/proofline-recorder/ProoflineRecorder.AppImage          # stable copy
cat ~/.local/share/applications/proofline-recorder.desktop              # handler entry
grep proofline ~/.config/mimeapps.list                                  # protocol registration
grep proofline ~/.local/share/applications/mimeapps.list                # legacy location
grep proofline ~/.local/share/applications/mimeinfo.cache               # MIME cache
cat ~/.config/autostart/proofline-recorder.desktop                      # login autostart
```

---

## 4. Building the Windows installer

### Option A — Docker cross-build script (recommended, builds from Linux)

`scripts/build-windows.sh` cross-compiles the NSIS installer on any Linux machine
with Docker — **no Windows host and nothing extra installed on yours**: Wine (which
electron-builder needs to embed the exe's version/resource block) lives inside the
build image, never on the host:

```bash
# from the repo root, requires Docker
./apps/recorder/scripts/build-windows.sh
# → apps/recorder/dist/ProoflineRecorder-Setup.exe   (NSIS, one-click, per-user)
# optional: ./apps/recorder/scripts/build-windows.sh /path/to/output-dir
```

What happens under the hood (`infrastructure/docker/recorder-build-win.Dockerfile`):
a Debian image with Wine (32- and 64-bit loaders) + Node 22 + pnpm installs the
recorder's dependencies with a frozen lockfile and runs `electron-builder --win nsis`,
which downloads the Windows Electron distribution and produces the installer. The
first build downloads the Wine layer (~5 minutes); later builds reuse the cache.

> **Why Docker and not a bare `pnpm dist --win nsis` on the host?** Two reasons:
> (1) electron-builder refuses to cross-build for Windows without Wine
> (`⨯ wine is required`) — the image carries it so the host doesn't have to;
> (2) on a full checkout electron-builder's dependency walk can trip over unrelated
> workspace packages (e.g. `ENOENT … apps/landing/node_modules/next` from a stale
> pnpm link) — the image copies only the recorder's manifests, so no other app can
> break the build.

### Option B — Manual build on a Windows machine

Build natively on Windows (also the path to take when you need code signing with a
hardware token):

```powershell
# from the repo root
corepack enable
pnpm install --filter @ai-qa/recorder...
pnpm --filter @ai-qa/recorder dist
# → apps/recorder/dist/ProoflineRecorder-Setup.exe   (NSIS, one-click, per-user)
```

(On Windows the target defaults to `win → nsis` from `package.json`, so a plain
`dist` run produces the same installer.)

### Verify a Windows build

The artifact must identify as a Nullsoft (NSIS) installer:

```bash
file dist/ProoflineRecorder-Setup.exe
# PE32 executable (GUI) … Nullsoft Installer self-extracting archive
```

Then install it on a Windows machine (or VM) and check the same things as on Linux:

1. The status window appears and the tray process keeps running.
2. `http://127.0.0.1:43117/ping` in a browser answers `running:true` with the version
   from `apps/recorder/package.json`.
3. After "Record steps in a browser" on the web app, the recording window opens
   (full-screen) with the address bar at the top.

Behavior of the installed app (handled by `main.js`):

- Registers `proofline-recorder://` via `app.setAsDefaultProtocolClient`.
- Adds a hidden login item (`--background`) so recordings start instantly after reboot.
- The Linux afterPack hook is a no-op on Windows — native sandbox and GPU stay enabled.

**Unsigned installer note:** Windows SmartScreen will show "Windows protected your PC".
Users click *More info → Run anyway*. To remove the warning, sign with a code-signing
certificate (add `win.certificateFile`/`win.signingHashAlgorithms` to the build config
when you have one).

---

## 5. Building the macOS DMG

Build **on a Mac** (Apple requires macOS for DMG creation; for arm64 + Intel builds use
`--mac --universal` or separate runs):

```bash
# from the repo root
corepack enable
pnpm install --filter @ai-qa/recorder...
pnpm --filter @ai-qa/recorder dist
# → apps/recorder/dist/ProoflineRecorder.dmg
```

Behavior of the installed app (handled by `main.js`):

- Registers the protocol through LaunchServices (`setAsDefaultProtocolClient`).
- Enables login-item autostart, detected via `getLoginItemSettings().wasOpenedAtLogin`.

**Unsigned app note:** Gatekeeper blocks first launch. Right-click the app → *Open* →
*Open*, or clear the quarantine flag:

```bash
xattr -d com.apple.quarantine "/Applications/Proofline Recorder.app"
```

---

## 6. Debugging — development

### Get the logs you already have

All recorder diagnostics go to **stdout/stderr** of the main process with an
`[recorder]` prefix. Run from a terminal and read:

```bash
cd apps/recorder
ELECTRON_ENABLE_LOGGING=1 pnpm start
```

`ELECTRON_ENABLE_LOGGING=1` additionally surfaces Chromium-level console/errors in the
terminal — essential for page load failures, GPU errors and renderer crashes.

Useful log lines and what they mean:

| Log line | Meaning |
|---|---|
| `Proofline Recorder 1.2.0 (pid …) starting` | First line of every launch — the exact build identity; compare it with `/ping`'s `version` when several builds coexist |
| `presence endpoint on http://127.0.0.1:43117/ping` (and the `[::1]` twin) | HTTP server up on BOTH loopback stacks (started at process start, before any window) — web app can detect the recorder |
| `another instance is already running and serving http://127.0.0.1:43117/ping — this launch exits` | The single-instance lock is held by a healthy resident instance which keeps serving `/ping`. A normal exit, not an install failure |
| `lock holder (pid …) is not serving port 43117 — an outdated or hung build. Taking over...` | The lock owner is NOT answering `/ping` (typical after upgrading: an old build stuck before its server start). The new build terminates it and relaunches itself — no manual `pkill` needed |
| `presence server on …: EADDRINUSE — the resident instance keeps serving` | Another instance already owns that address (fine if that one is healthy) |
| `presence server: [::1] not available on this machine — skipped` | The machine has no IPv6 stack; the IPv4 endpoint still serves |
| `installed: handler=…, protocol registered, autostart enabled` | Linux self-install completed |
| `uninstalled: registration, autostart, and app files removed` | Uninstall (web UI's Uninstall button via `POST /uninstall`, or the `proofline-recorder://uninstall` deep link) — the app quits right after |
| `recording <sessionId> → <target>` | Recording window opened, event push started |
| `push failed: …` | API rejected an events PUT — check token/API URL |
| `session ended on the platform — stopping` | User pressed Stop in the web app |

### Test a deep link without the web app

Deep links arrive as argv entries, so you can launch a recording directly in dev:

```bash
cd apps/recorder
pnpm start -- "proofline-recorder://record?session=test-1&token=<jwt>&api=http://localhost:4000&target=https://example.com&project=<projectId>"
```

(All five params — session, token, api, target, project — are required or the link is
ignored with `ignoring malformed deep link`.)

### Inspect the recorded page (DevTools)

The recording window is a normal BrowserWindow. To inspect injection/event capture,
temporarily add one line in `createRecordingWindow()` in `main.js`:

```js
win.webContents.openDevTools({ mode: "detach" });
```

### Common dev problems

| Symptom | Cause / fix |
|---|---|
| `The SUID sandbox helper binary was found, but is not configured correctly` | Dev runs can't set SUID — the `start` script already sets `ELECTRON_DISABLE_SANDBOX=1`; don't strip it |
| `Missing X server / DISPLAY` (SSH session) | Electron needs a desktop session; for CI use `xvfb-run -a pnpm --filter @ai-qa/recorder start` |
| Renderer crashes on NVIDIA machines | Relaunch with `--disable-gpu-mode` — default runs use full hardware acceleration (`--ignore-gpu-blocklist`); the flag falls back to software rendering for broken drivers |
| `libva error: … init failed` in the console | Harmless VA-API probe noise (see section 7) — dev runs can silence it with `LIBVA_MESSAGING_LEVEL=0 pnpm start` |
| Port 43117 already in use | `ss -ltnp | grep 43117` — kill the stale instance or keep the healthy one |
| Events not captured on a page | Check DevTools console for injection errors; the script re-injects on every `did-finish-load` navigation |
| Protocol handler not firing in dev | `setAsDefaultProtocolClient(PROTOCOL, process.execPath, [appPath])` registered your *dev* electron — re-run after moving the project folder |

---

## 7. Debugging — production (packaged builds)

### Golden rule: launch from a terminal

The packaged app has no log files — stdout is the only channel. Reproduce any issue with
logs visible:

```bash
# Linux (AppImage or installed copy)
ELECTRON_ENABLE_LOGGING=1 ./ProoflineRecorder.AppImage 2>&1 | tee recorder-debug.log
ELECTRON_ENABLE_LOGGING=1 ~/.local/share/proofline-recorder/ProoflineRecorder.AppImage
```

```powershell
# Windows (installed app) — run from PowerShell
$env:ELECTRON_ENABLE_LOGGING=1; & "$env:LOCALAPPDATA\Programs\Proofline Recorder\Proofline Recorder.exe"
```

```bash
# macOS (installed app binary)
ELECTRON_ENABLE_LOGGING=1 "/Applications/Proofline Recorder.app/Contents/MacOS/Proofline Recorder"
```

### Attach DevTools to a packaged build

Chromium's remote debugging switch passes straight through the app:

```bash
./ProoflineRecorder.AppImage --remote-debugging-port=9222
```

Then open `chrome://inspect` in any local Chrome → *Configure* → add `localhost:9222` →
inspect the live recording window. This is the fastest way to diagnose blank/black
windows and injection failures on a customer machine.

### Health-check sequence (in order)

1. **Process alive?** `ps aux | grep -i proofline` (Linux) — you should see the
   `--no-sandbox` flag and, on Linux, the wrapper's ldd check has passed.
2. **Presence server?** `curl http://127.0.0.1:43117/ping` → `running:true` and a
   `version` matching `apps/recorder/package.json`. Also try `curl http://[::1]:43117/ping`.
   The setup modal shows the reported version next to "Installed on this computer".
3. **Installed correctly?** Check the six artifacts from section 3.
4. **Deep link works?** Paste `proofline-recorder://…` into the browser address bar
   (or `xdg-open "proofline-recorder://…"` on Linux, `start "" "proofline-recorder://…"`
   on Windows, `open "proofline-recorder://…"` on macOS).
   If the browser does nothing after a *re-install*, restart the browser — handlers are
   cached at browser startup.

### Common production problems

| Symptom | Cause / fix |
|---|---|
| Browser console shows **`GET http://localhost:43117/ping net::ERR_CONNECTION_REFUSED`** (button stays disabled, downloads stay enabled) | **Nothing is listening on port 43117 — the recorder is not running (or not the fixed build).** A refused connection is NOT a CORS/permission problem (those log CORS errors). In order: (1) run the AppImage from a terminal — the first lines must print `presence endpoint on http://127.0.0.1:43117/ping`; if they don't, the binary is an **outdated build** (source fixes only ship after a rebuild — see the warning at the top of this guide), so rebuild + re-download + re-run; (2) if the launch exits instantly with `another instance is already running… Taking over...`, let it finish — the new build kills the stale instance and relaunches itself; (3) if the AppImage doesn't start at all, check the FUSE row below. Verify with `ss -ltnp \| grep 43117` (must show 127.0.0.1:43117 AND [::1]:43117) and `curl http://127.0.0.1:43117/ping` |
| `xdg-settings: not found` / `xdg-mime: not found` errors | **Fixed in the current code** — registration is pure file writes. Seeing this means the machine runs an OLD build → rebuild and redistribute |
| Browser dialog says **"Open xdg-open?"** when clicking *Record steps in a browser* | **This is the browser's own confirmation dialog, not the recorder's code.** Chrome on Linux labels every custom-protocol launcher generically as "xdg-open" (long-standing Chromium behavior — issue 41184476); clicking **Open xdg-open** launches Proofline Recorder normally. Tick *Always allow … to open links of this type* in the dialog to skip future prompts. Firefox and GNOME resolve the real name ("Proofline Recorder") from the registration set written at install — if they still show a generic name, restart the browser after the first install so it re-reads the handler database. NOTE: the Recorder Setup modal's **Uninstall** button does NOT use a deep link anymore — it calls `POST /uninstall` on the presence endpoint directly, so it never triggers this dialog (a "No App Available" after Uninstall means the web app is an outdated build) |
| `libva error: /usr/lib/…/dri/iHD_drv_video.so init failed` | **Harmless, and silenced.** Why it appears: Chromium (not our code) probes the system's VA-API video-acceleration driver at startup by dlopen'ing the system `libva` — on machines without an Intel GPU (or with NVIDIA) the Intel driver `iHD_drv_video.so` fails to initialize and libva prints this line. It does NOT mean a missing dependency — the AppImage is fully self-contained and libva is an optional runtime probe. The launcher sets `LIBVA_MESSAGING_LEVEL=0`, so the message is gone in default (GPU) mode; `--disable-gpu-mode` runs disable the whole VA-API stack (`--disable-accelerated-video-decode`, `--disable-features=VaapiVideoDecodeLinuxGL,VaapiVideoEncoder,VaapiIgnoreDriverChecks`) as well. You can also silence it manually: `LIBVA_MESSAGING_LEVEL=0 ./ProoflineRecorder.AppImage` |
| `dlopen(): error loading libfuse.so.2` / AppImage won't mount | Minimal distro without FUSE. Either install it (`sudo apt install libfuse2` / `dnf install fuse-libs`) or run without FUSE: `APPIMAGE_EXTRACT_AND_RUN=1 ./ProoflineRecorder.AppImage` |
| `version 'GLIBC_2.xx' not found` | Old distro + locally-built AppImage. Use the Docker baseline build (section 3, option B) |
| `Proofline Recorder cannot start: missing system libraries: …` | The Linux wrapper prints the exact list and the fix — install them (e.g. `sudo apt install libgtk-3-0 libnss3 libasound2`) |
| Blank / black recording window, or GPU-heavy page sections missing | Default mode runs with full hardware acceleration (`--enable-gpu --ignore-gpu-blocklist`). If a driver is broken, relaunch with `--disable-gpu-mode` (software rendering); confirm the active mode via the startup log line and remote DevTools (`chrome://gpu`). `[recorder] GPU process gone (…)` in the terminal means the GPU process died and Chromium fell back |
| Deep link opens browser page instead of app | Protocol registration missing: check both `mimeapps.list` files + `mimeinfo.cache` (Linux) / re-run the installer (Win/Mac); restart the browser afterwards |
| Web page never detects the recorder (button stays disabled / no green check) even though `/ping` answers in a terminal | The browser is blocking the loopback probe. **Chrome 142+ / Edge 143+ enforce "Local Network Access" (LNA)** — a public page may only fetch `127.0.0.1` after you allow the site's *Local network access* permission: click the site/tune icon left of the address bar → *Site settings* → *Local network access* → *Allow*, then reload. The setup modal shows this hint automatically when the permission is denied, and its **Check again** button re-probes instantly. Other causes: the page is plain HTTP on a LAN address (not a secure context — browsers refuse local detection there; serve the web app over HTTPS or localhost), an extension/proxy intercepting `127.0.0.1`. NOTE: if the console error is `net::ERR_CONNECTION_REFUSED` (not a CORS error), skip this row — the recorder itself is not running; use the refused-connection row above. The page probes all three spellings (`127.0.0.1`, `localhost`, `[::1]`) every 2s, on focus, and on tab visibility, and the endpoint answers CORS plus both the PNA and LNA opt-in headers |
| A healthy old instance keeps the new build from installing | The single-instance lock means one recorder per machine. A new launch that finds the lock holder **serving `/ping`** exits quietly (normal). If the lock holder is NOT serving (outdated/hung build), the new build terminates it and relaunches itself automatically. Manual fallback: `pkill -f ProoflineRecorder && ./ProoflineRecorder.AppImage` |
| Recording window opens, no steps appear | Terminal shows `push failed: …` — API unreachable or token expired; re-start the recording from the web app to mint a fresh link |
| SmartScreen warning (Windows) | Unsigned installer — *More info → Run anyway*, or sign the installer |
| Gatekeeper warning (macOS) | Unsigned app — right-click → Open, or `xattr -d com.apple.quarantine` (section 5) |

### Collecting a bug report

Ask the user to run (Linux example) and send the file:

```bash
ELECTRON_ENABLE_LOGGING=1 ./ProoflineRecorder.AppImage --enable-logging --v=1 2>&1 | tee recorder-debug.log
```

Include: OS + version (`cat /etc/os-release`), how the app was installed, and the
`/ping` output. That combination reproduces almost every reported failure.

---

## 8. Quick reference card

| Task | Command |
|---|---|
| Dev run (never started by root `pnpm dev`) | `pnpm --filter @ai-qa/recorder start` |
| Health probe | `curl http://127.0.0.1:43117/ping` (and `curl http://[::1]:43117/ping`) |
| HTTP uninstall probe (what the web UI calls) | `curl -X POST http://127.0.0.1:43117/uninstall` |
| Upload installers to S3 (`WebViewRecorder/`) | `./scripts/upload-recorder-installers.sh all\|windows\|linux\|mac` |
| **Rebuild after changing recorder source** | `cd apps/recorder && pnpm dist --linux AppImage`, then run the fresh `dist/ProoflineRecorder.AppImage` once |
| Linux portable build | `./apps/recorder/scripts/build-linux.sh` (Docker, glibc 2.31 floor) |
| Linux quick build | `cd apps/recorder && pnpm dist --linux AppImage` |
| Windows build (from Linux, recommended) | `./apps/recorder/scripts/build-windows.sh` (Docker cross-build, Wine inside the image) |
| Windows build (on Windows) | `pnpm --filter @ai-qa/recorder dist` → `ProoflineRecorder-Setup.exe` |
| macOS build (on a Mac) | `pnpm --filter @ai-qa/recorder dist` → `ProoflineRecorder.dmg` |
| Logs from packaged app | launch from terminal with `ELECTRON_ENABLE_LOGGING=1` |
| DevTools on packaged app | `--remote-debugging-port=9222` + `chrome://inspect` |
| AppImage without FUSE | `APPIMAGE_EXTRACT_AND_RUN=1 ./ProoflineRecorder.AppImage` |
| Silence libva probe noise | `LIBVA_MESSAGING_LEVEL=0 ./ProoflineRecorder.AppImage` (launcher already sets it) |
