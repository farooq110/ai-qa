/**
 * Repository archive ingestion (Phase 2): one tarball at the pinned commit instead of per-file
 * API reads. Faster and lets analysis walk directories outside `rootDirectory` (the backend, in a
 * monorepo) without one HTTP round trip per file. Falls back to null on any failure so the caller
 * can use the existing per-provider file readers — this is a speed/scope upgrade, not a hard
 * dependency.
 *
 * Deterministic and stack-agnostic by design: this file only fetches, extracts, walks, caps and
 * hashes bytes. It has no opinion on what a file contains — that stays with the LLM.
 */
import { createWriteStream, createReadStream } from "node:fs";
import { mkdtemp, rm, stat, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { prioritizePaths } from "./analyzer";

export type AnalysisProvider = "GITHUB" | "BITBUCKET" | "GITLAB";
export interface ArchiveTarget { provider: AnalysisProvider; repository: string; gitlabApi: string }

export interface ArchiveFile { path: string; content: string; hash: string; area: "frontend" | "backend" }
export interface ArchiveSnapshot { files: ArchiveFile[]; truncated: boolean }

const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;
const MAX_FILE_BYTES = 250_000;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_FILE_COUNT = 8_000;
const CODE_FILE = /\.(tsx?|jsx?|vue|svelte|astro)$/;
const EXCLUDED_DIR = /(^|\/)(node_modules|\.git|dist|build|\.next|\.nuxt|out)(\/|$)/;

function archiveUrl(target: ArchiveTarget, sha: string): string {
  if (target.provider === "GITLAB") return `${target.gitlabApi}/projects/${encodeURIComponent(target.repository)}/repository/archive.tar.gz?sha=${encodeURIComponent(sha)}`;
  if (target.provider === "BITBUCKET") return `https://bitbucket.org/${target.repository}/get/${sha}.tar.gz`;
  return `https://api.github.com/repos/${target.repository}/tarball/${sha}`;
}

/** Downloads the archive to a temp file, capped at MAX_ARCHIVE_BYTES; null (not thrown) on any failure. */
async function downloadArchive(url: string, headers: Record<string, string>, destination: string): Promise<boolean> {
  const response = await fetch(url, { headers }).catch(() => null);
  if (!response?.ok || !response.body) return false;
  const file = createWriteStream(destination);
  let bytes = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) { file.close(); return false; }
      if (!file.write(chunk)) await new Promise<void>((resolve) => file.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => file.end((error?: Error) => (error ? reject(error) : resolve())));
    return true;
  } catch {
    file.close();
    return false;
  }
}

/** `tar -xz --strip-components=1`, excluding noise directories. Returns false (not thrown) on any failure. */
function extractArchive(archivePath: string, destinationDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("tar", [
      "-xzf", archivePath, "--strip-components=1", "--no-same-owner", "--no-same-permissions",
      "-C", destinationDir,
      "--exclude=node_modules", "--exclude=.git", "--exclude=dist", "--exclude=build", "--exclude=.next", "--exclude=.nuxt"
    ]);
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

/** Every file under `dir`, repo-relative to `extractRoot`, skipping symlinks and excluded directories. */
async function walk(extractRoot: string, dir: string, out: string[]): Promise<void> {
  const absolute = join(extractRoot, dir);
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    if (EXCLUDED_DIR.test(`${relative}/`)) continue;
    const absoluteChild = join(extractRoot, relative);
    const info = await lstat(absoluteChild).catch(() => null);
    if (!info || info.isSymbolicLink()) continue;
    if (info.isDirectory()) await walk(extractRoot, relative, out);
    else if (info.isFile()) out.push(relative);
  }
}

/**
 * Downloads and extracts the repo archive at `sha`, then reads every code/config file under
 * `root` and `backendDirs` (top-level, repo-relative). Null means "could not use the archive" —
 * the caller should fall back to its existing per-file readers; this is never thrown.
 */
export async function downloadSnapshot(
  target: ArchiveTarget,
  sha: string,
  headers: Record<string, string>,
  roots: { root: string; backendDirs: string[] }
): Promise<ArchiveSnapshot | null> {
  const workDir = await mkdtemp(join(tmpdir(), "repo-archive-"));
  const archivePath = join(workDir, "archive.tar.gz");
  try {
    const downloaded = await downloadArchive(archiveUrl(target, sha), headers, archivePath);
    if (!downloaded) return null;
    if ((await stat(archivePath).catch(() => null))?.size === undefined) return null;
    return await collectFromArchive(archivePath, roots);
  } catch {
    return null;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Extracts an already-downloaded tarball and walks it into an ArchiveSnapshot. Split out from
 * downloadSnapshot so archive.check.ts can exercise real extraction + caps + hashing against a
 * tarball built with `git archive`, without a network call.
 */
export async function collectFromArchive(
  archivePath: string,
  roots: { root: string; backendDirs: string[] }
): Promise<ArchiveSnapshot | null> {
  const extractDir = await mkdtemp(join(tmpdir(), "repo-archive-extract-"));
  try {
    const extracted = await extractArchive(archivePath, extractDir);
    if (!extracted) return null;

    const backendDirs = [...new Set(roots.backendDirs.map((dir) => dir.replace(/^\/+|\/+$/g, "")).filter(Boolean))];
    const scopes: Array<{ dir: string; area: "frontend" | "backend" }> = [
      { dir: roots.root, area: "frontend" },
      ...backendDirs.map((dir) => ({ dir, area: "backend" as const }))
    ];

    const candidates: Array<{ path: string; area: "frontend" | "backend" }> = [];
    for (const { dir, area } of scopes) {
      const relativePaths: string[] = [];
      await walk(extractDir, dir, relativePaths);
      for (const path of relativePaths) if (CODE_FILE.test(path) || isConfigFile(path)) candidates.push({ path, area });
    }

    const codeOnly = candidates.filter((entry) => CODE_FILE.test(entry.path));
    const prioritizedOrder = prioritizePaths(codeOnly.map((entry) => entry.path));
    const orderIndex = new Map(prioritizedOrder.map((path, index) => [path, index]));
    const configEntries = candidates.filter((entry) => isConfigFile(entry.path));
    const codeEntries = candidates.filter((entry) => CODE_FILE.test(entry.path) && orderIndex.has(entry.path))
      .sort((a, b) => orderIndex.get(a.path)! - orderIndex.get(b.path)!);

    const files: ArchiveFile[] = [];
    let totalBytes = 0;
    let truncated = false;
    for (const entry of [...configEntries, ...codeEntries]) {
      if (files.length >= MAX_FILE_COUNT || totalBytes >= MAX_TOTAL_BYTES) { truncated = true; break; }
      const absolutePath = join(extractDir, entry.path);
      const info = await stat(absolutePath).catch(() => null);
      if (!info || info.size > MAX_FILE_BYTES) continue;
      const content = await readFile(absolutePath);
      if (content === null) continue;
      totalBytes += info.size;
      files.push({ path: entry.path, content, hash: createHash("sha256").update(content).digest("hex"), area: entry.area });
    }
    return { files, truncated };
  } catch {
    return null;
  } finally {
    await rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readFile(absolutePath: string): Promise<string | null> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(absolutePath)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

const CONFIG_FILE_PATTERN = /(^|\/)(package\.json|(?:tsconfig|jsconfig)[^/]*\.json|next\.config\.(?:[cm]?[jt]s)|vite\.config\.(?:[cm]?[jt]s))$/i;
function isConfigFile(path: string): boolean {
  return CONFIG_FILE_PATTERN.test(path) && !EXCLUDED_DIR.test(`${path}/`) && path.split(sep).length <= 6;
}
