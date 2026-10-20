/**
 * Self-check for archive extraction (Phase 2a). Run:
 * pnpm exec tsc -p tsconfig.json --outDir .check-out && node .check-out/analysis/archive.check.js
 * (delete .check-out afterwards). Builds a real tarball with `git archive` against the local ERP
 * clone and checks the extracted file set matches `git ls-files` under the same filters — no
 * network call, so this runs anywhere the clone is present; it no-ops (not fails) if it's absent.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFromArchive } from "./repo-archive";

const ERP_CLONE = "/home/muhammad-roshaan-khan/Desktop/Projects/ERP";
const CODE_FILE = /\.(tsx?|jsx?)$/;

/**
 * Regression check: a .vue/.svelte/.astro file must survive final selection, not just the initial
 * CODE_FILE filter. A prior bug scored/ordered only .ts(x)/.js(x) paths, so every non-JS/TS code
 * file silently never made it past that ordering step into the kept set, even though it matched
 * CODE_FILE - invisible until tested against a non-React/Next stack.
 */
async function checkNonJsCodeFileSurvives() {
  const workDir = mkdtempSync(join(tmpdir(), "archive-vue-check-"));
  try {
    // --strip-components=1 (collectFromArchive always applies it, matching real GitHub/GitLab/
    // Bitbucket tarballs) needs one wrapper directory layer, same as the git-archive --prefix used
    // elsewhere in this file.
    const repoDir = join(workDir, "repo");
    const srcDir = join(repoDir, "src", "views");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "Home.vue"), "<template><div>Home</div></template>");
    writeFileSync(join(repoDir, "main.js"), "export default 1;");
    const archivePath = join(workDir, "repo.tar.gz");
    execFileSync("tar", ["-czf", archivePath, "-C", workDir, "repo"]);
    const snapshot = await collectFromArchive(archivePath, { root: "", backendDirs: [] });
    assert.ok(snapshot, "synthetic archive extracts");
    const paths = snapshot!.files.map((file) => file.path);
    assert.ok(paths.includes("src/views/Home.vue"), `.vue file must survive final selection (got: ${paths.join(", ")})`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function run() {
  await checkNonJsCodeFileSurvives();
  console.log("archive.check.ts: non-JS code file (.vue) survives final selection");
  if (!existsSync(ERP_CLONE)) {
    console.log("ERP clone not found — skipping archive.check.ts (no-op, not a failure)");
    return;
  }

  const workDir = mkdtempSync(join(tmpdir(), "archive-check-"));
  const archivePath = join(workDir, "erp.tar.gz");
  try {
    // --prefix mirrors what GitHub/GitLab/Bitbucket tarballs do: everything under one wrapper
    // directory, which collectFromArchive's --strip-components=1 removes.
    execFileSync("git", ["-C", ERP_CLONE, "archive", "--format=tar.gz", "--prefix=repo/", "-o", archivePath, "HEAD", "web", "api"]);

    const snapshot = await collectFromArchive(archivePath, { root: "web", backendDirs: ["api"] });
    assert.ok(snapshot, "archive extraction must succeed against a real git-built tarball");
    const extractedPaths = new Set(snapshot!.files.map((file) => file.path));

    const expected = new Set(
      execFileSync("git", ["-C", ERP_CLONE, "ls-files", "web", "api"], { encoding: "utf8" })
        .split("\n")
        .filter((path) => path && CODE_FILE.test(path))
    );

    const missing = [...expected].filter((path) => !extractedPaths.has(path));
    const extra = [...extractedPaths].filter((path) => CODE_FILE.test(path) && !expected.has(path));
    assert.deepEqual(missing, [], `archive extraction missed files git ls-files reports: ${missing.slice(0, 10).join(", ")}`);
    assert.deepEqual(extra, [], `archive extraction produced files git ls-files does not report: ${extra.slice(0, 10).join(", ")}`);

    const frontendFiles = snapshot!.files.filter((file) => file.area === "frontend");
    const backendFiles = snapshot!.files.filter((file) => file.area === "backend");
    assert.ok(frontendFiles.every((file) => file.path.startsWith("web/")), "every frontend-scoped file is under web/");
    assert.ok(backendFiles.every((file) => file.path.startsWith("api/")), "every backend-scoped file is under api/");
    assert.ok(frontendFiles.length > 0 && backendFiles.length > 0, "both scopes produced files");

    console.log(`archive.check.ts: ${snapshot!.files.length} files extracted (${frontendFiles.length} frontend, ${backendFiles.length} backend), 0 unexpected, 0 missing`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exit(1); });
