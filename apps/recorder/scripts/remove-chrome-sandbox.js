/**
 * electron-builder afterPack hook (Linux):
 * 1. Removes chrome-sandbox — AppImages cannot preserve its setuid bit inside the
 *    squashfs mount, and Chromium aborts instead of falling back when the file exists
 *    with wrong permissions.
 * 2. Wraps the main executable in a launcher that adds --no-sandbox. On distros that
 *    disable unprivileged user namespaces (Ubuntu 23.10+ AppArmor policy) Chromium has
 *    no usable sandbox otherwise and aborts before the app code can intervene. The
 *    recorder only renders pages the user chooses to record.
 */
const { rmSync, writeFileSync, chmodSync, renameSync, existsSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");

exports.default = function hardenLinuxPack(context) {
  if (process.platform !== "linux") return;
  const appOutDir = context.appOutDir;

  const sandboxPath = path.join(appOutDir, "chrome-sandbox");
  try {
    rmSync(sandboxPath);
    console.log("  • removed chrome-sandbox (recorder runs with --no-sandbox)");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  // Detect the main Electron executable: the largest ELF binary in the pack directory
  // (its name is sanitized differently across electron-builder versions).
  let binaryPath = null;
  let maxSize = 50 * 1024 * 1024; // the main binary is far larger than any helper
  for (const entry of readdirSync(appOutDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "chrome_crashpad_handler") continue;
    const filePath = path.join(appOutDir, entry.name);
    try {
      const size = statSync(filePath).size;
      if (size > maxSize) {
        const fd = require("node:fs").openSync(filePath, "r");
        const magic = Buffer.alloc(4);
        require("node:fs").readSync(fd, magic, 0, 4, 0);
        require("node:fs").closeSync(fd);
        if (magic.toString("latin1").startsWith("\x7fELF")) {
          maxSize = size;
          binaryPath = filePath;
        }
      }
    } catch {}
  }
  if (!binaryPath) {
    console.warn("  • could not locate the Electron executable — sandbox wrapper not applied");
    return;
  }

  const wrapperPath = `${binaryPath}.wrapped`;
  renameSync(binaryPath, wrapperPath);
  writeFileSync(
    binaryPath,
    [
      "#!/bin/sh",
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      'BIN="$DIR/' + path.basename(wrapperPath) + '"',
      // Missing shared libraries (libgtk-3/libnss3/libasound2 on minimal systems)
      // otherwise crash silently — name them and hint the fix instead.
      'MISSING="$(ldd "$BIN" 2>/dev/null | grep "not found" | sed \'s/^[[:space:]]*//\' | cut -d" " -f1 | sort -u)"',
      'if [ -n "$MISSING" ]; then',
      '  echo "Proofline Recorder cannot start: missing system libraries:" >&2',
      '  echo "$MISSING" >&2',
      '  echo "Install them with your package manager (e.g. sudo apt install libgtk-3-0 libnss3 libasound2, or dnf/yast equivalents) and try again." >&2',
      '  exit 1',
      "fi",
      // Belt and braces for the libva probe: even with VA-API switched off in
      // main.js, some Chromium builds still dlopen the system libva and its
      // driver can print "libva error: ... init failed" (harmless probe noise on
      // machines without an Intel GPU). LIBVA_MESSAGING_LEVEL=0 tells libva to
      // stay quiet; kept overridable for anyone debugging video acceleration.
      'export LIBVA_MESSAGING_LEVEL="${LIBVA_MESSAGING_LEVEL:-0}"',
      'exec "$BIN" --no-sandbox "$@"'
    ].join("\n") + "\n"
  );
  chmodSync(binaryPath, 0o755);
  console.log(`  • wrapped ${path.basename(binaryPath)} with --no-sandbox launcher + dependency check`);
};
