#!/usr/bin/env node
/**
 * Upload Proofline Recorder installers to S3 (folder: WebViewRecorder).
 *
 * Usage:
 *   node scripts/upload-installer.mjs [linux|windows|mac|all]
 *   ./scripts/upload-recorder-installers.sh [linux|windows|mac|all]   # shell wrapper
 *
 * Defaults to "all" if no argument is given (only uploads files that exist).
 *
 * For every selected installer the script:
 *   1. checks whether the file already exists in the bucket's WebViewRecorder/
 *      folder (HeadObject) and reports what is there,
 *   2. ALWAYS uploads the local file from apps/recorder/dist — an existing S3
 *      object is replaced with the latest local version (PutObject overwrites).
 *
 * Configuration is resolved from (first non-empty wins):
 *   1. real environment variables (AWS_*),
 *   2. the repo root .env file.
 * Required:
 *   AWS_S3_BUCKET_NAME          no fallback — the script fails fast when unset
 *   AWS_S3_REGION               optional, defaults to us-east-1
 * Credentials — EITHER of:
 *   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY   (in .env or the environment)
 *   …or nothing at all: the AWS SDK default credential chain then resolves
 *   them from ~/.aws/credentials, ~/.aws/config (e.g. after `aws configure`),
 *   AWS_PROFILE, container/instance roles, etc. Any AWS_* values found in .env
 *   (AWS_PROFILE, AWS_SESSION_TOKEN, AWS_ENDPOINT_URL, …) are exported to the
 *   process so the SDK chain sees them.
 *
 * Files are stored under the "WebViewRecorder/" prefix as private objects.
 * The API generates a short-lived presigned GET URL on each download request
 * (using @aws-sdk/s3-request-presigner, already installed in apps/api), so no
 * bucket-level public access is required — the Recorder Setup modal's download
 * buttons and curl commands go through the API and always serve this exact file.
 *
 * e.g. s3://agentic-qa-proofline-dev/WebViewRecorder/ProoflineRecorder.AppImage
 */

import { readFileSync, createReadStream, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ENV_PATH = join(ROOT, ".env");

// Resolve @aws-sdk from the API package where it is installed in the pnpm workspace.
const apiDir = join(ROOT, "apps", "api");
const require = createRequire(pathToFileURL(join(apiDir, "package.json")));
const { S3Client, PutObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");

/** All installer objects live inside this folder in the bucket. */
const S3_FOLDER = "WebViewRecorder";

// ── Load .env ──────────────────────────────────────────────────────────────
/** Minimal dotenv-compatible parser: handles BOM, CRLF, `export KEY=…`,
 *  quoted values, and inline `# comments` after unquoted values. */
function parseEnv(raw) {
  const values = {};
  for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("export ")) trimmed = trimmed.slice("export ".length).trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    const quoted = val.match(/^"([^"]*)"|^'([^']*)'/);
    if (quoted) val = quoted[1] ?? quoted[2] ?? "";
    else {
      const hash = val.indexOf(" #"); // strip a trailing inline comment
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    if (key) values[key] = val;
  }
  return values;
}

function loadEnv(filePath) {
  if (!existsSync(filePath)) return { found: false, values: {}, error: null };
  try {
    return { found: true, values: parseEnv(readFileSync(filePath, "utf8")), error: null };
  } catch (error) {
    return { found: true, values: {}, error: error?.message ?? String(error) };
  }
}

const dotEnv = loadEnv(ENV_PATH);

/** First NON-EMPTY value wins: a real environment variable beats .env, but an
 *  EMPTY environment variable must never mask a real value from .env (the old
 *  `{ ...loadEnv(...), ...process.env }` merge had exactly that bug). */
function resolveVar(name) {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== "") return { value: fromProcess, source: "environment" };
  const fromFile = dotEnv.values[name];
  if (fromFile !== undefined && fromFile !== "") return { value: fromFile, source: ".env" };
  return { value: undefined, source: "none" };
}

const BUCKET = resolveVar("AWS_S3_BUCKET_NAME");
const REGION = resolveVar("AWS_S3_REGION");
const ACCESS_KEY = resolveVar("AWS_ACCESS_KEY_ID");
const SECRET_KEY = resolveVar("AWS_SECRET_ACCESS_KEY");
const PROFILE = resolveVar("AWS_PROFILE");

// Export every non-empty AWS_* value from .env into the process so the SDK's
// default credential chain can use them (AWS_PROFILE, AWS_SESSION_TOKEN,
// AWS_ENDPOINT_URL, …). Real environment variables keep priority. This runs
// AFTER the resolveVar snapshot above so the diagnostic "source" labels stay
// truthful (the exported values would otherwise look like environment vars).
for (const [key, value] of Object.entries(dotEnv.values)) {
  if (key.startsWith("AWS_") && value !== "" && (process.env[key] === undefined || process.env[key] === "")) {
    process.env[key] = value;
  }
}

// ── Credential resolution: explicit keys OR the AWS SDK default chain ───────
const sharedCredentialsFile = join(homedir(), ".aws", "credentials");
const sharedConfigFile = join(homedir(), ".aws", "config");
const hasExplicitKeys = Boolean(ACCESS_KEY.value && SECRET_KEY.value);
const containerRole = Boolean(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
const webIdentity = Boolean(process.env.AWS_WEB_IDENTITY_TOKEN_FILE || process.env.AWS_ROLE_ARN);
const chainSources = [
  ...(existsSync(sharedCredentialsFile) ? [`~/.aws/credentials (${sharedCredentialsFile})`] : []),
  ...(existsSync(sharedConfigFile) ? [`~/.aws/config (${sharedConfigFile})`] : []),
  ...(containerRole ? ["container credentials"] : []),
  ...(webIdentity ? ["web-identity / role"] : []),
];

function printCredentialGuide() {
  console.error("    Fix it with ONE of these:");
  console.error(`      1. Fill AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in ${ENV_PATH}`);
  console.error("         (copy the \"AWS S3 CONFIG\" section from .env.example).");
  console.error("      2. Run `aws configure` once — creates ~/.aws/credentials, no .env keys needed.");
  console.error("      3. Export AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in your shell, or set");
  console.error("         AWS_PROFILE in .env to the name of a profile from ~/.aws/credentials.");
}

// ── Validate: fail fast with PRECISE, per-variable guidance ────────────────
if (dotEnv.error) console.warn(`⚠️  Could not read ${ENV_PATH} (${dotEnv.error}) — continuing with environment variables only.`);

if (!BUCKET.value) {
  // The bucket has no fallback — without it there is nowhere to upload to.
  console.error(`❌  AWS_S3_BUCKET_NAME is not set.`);
  console.error(`    Looked in: ${ENV_PATH} ${dotEnv.found ? "(file found)" : "(file NOT FOUND — copy .env.example to .env)"} and the environment.`);
  if (dotEnv.found && dotEnv.values.AWS_S3_BUCKET_NAME === undefined) {
    console.error("    The .env file exists but has no AWS_S3_BUCKET_NAME line — add it (see the \"AWS S3 CONFIG\" section of .env.example).");
  } else if (dotEnv.found && dotEnv.values.AWS_S3_BUCKET_NAME === "") {
    console.error('    The .env file has an EMPTY AWS_S3_BUCKET_NAME= — fill in the bucket name.');
  }
  process.exit(1);
}

if (ACCESS_KEY.value !== undefined && !SECRET_KEY.value) {
  console.error("❌  AWS_ACCESS_KEY_ID is set but AWS_SECRET_ACCESS_KEY is missing — set BOTH or neither.");
  console.error(`    AWS_ACCESS_KEY_ID came from: ${ACCESS_KEY.source}. AWS_SECRET_ACCESS_KEY: ${SECRET_KEY.source}.`);
  printCredentialGuide();
  process.exit(1);
}
if (!ACCESS_KEY.value && SECRET_KEY.value) {
  console.error("❌  AWS_SECRET_ACCESS_KEY is set but AWS_ACCESS_KEY_ID is missing — set BOTH or neither.");
  console.error(`    AWS_SECRET_ACCESS_KEY came from: ${SECRET_KEY.source}. AWS_ACCESS_KEY_ID: ${ACCESS_KEY.source}.`);
  printCredentialGuide();
  process.exit(1);
}

if (!hasExplicitKeys && chainSources.length === 0) {
  // No keys anywhere and nothing the SDK chain could read — fail fast instead
  // of letting the SDK hunt (and time out) for instance roles.
  console.error("❌  No AWS credentials found — the upload cannot authenticate.");
  console.error(`    Checked: ${ENV_PATH} ${dotEnv.found ? "(file found)" : "(file NOT FOUND)"}, environment variables,`);
  console.error(`    ${sharedCredentialsFile} (not found), ${sharedConfigFile} (not found).`);
  printCredentialGuide();
  process.exit(1);
}

const s3 = new S3Client({
  region: REGION.value ?? "us-east-1",
  ...(hasExplicitKeys
    ? { credentials: { accessKeyId: ACCESS_KEY.value, secretAccessKey: SECRET_KEY.value } }
    : // No explicit keys → the SDK default credential chain resolves them
      // (profile files, container/instance roles). AWS_PROFILE and friends
      // from .env were exported to process.env above.
      {}),
});

// ── Startup report: exactly what the run resolved ──────────────────────────
console.log(`Proofline Recorder installer upload — target: s3://${BUCKET.value}/${S3_FOLDER}/`);
console.log(`    bucket:   ${BUCKET.value} (from ${BUCKET.source})`);
console.log(`    region:   ${REGION.value ? `${REGION.value} (from ${REGION.source})` : "us-east-1 (default)"}`);
console.log(hasExplicitKeys
  ? `    creds:    explicit AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (from ${ACCESS_KEY.source})`
  : `    creds:    AWS SDK default credential chain (${chainSources.join(", ")})${PROFILE.value ? ` — profile "${PROFILE.value}"` : ""}`);
if (dotEnv.found) console.log(`    env file: ${ENV_PATH}`);
else console.log(`    env file: ${ENV_PATH} — not found, using environment variables only`);

// ── Installer definitions ──────────────────────────────────────────────────
const DIST_DIR = join(ROOT, "apps", "recorder", "dist");

const ALL_INSTALLERS = [
  { platform: "linux",   file: "ProoflineRecorder.AppImage",  mime: "application/octet-stream" },
  { platform: "windows", file: "ProoflineRecorder-Setup.exe", mime: "application/octet-stream" },
  { platform: "mac",     file: "ProoflineRecorder.dmg",       mime: "application/octet-stream" },
];

// ── Determine which platforms to upload ───────────────────────────────────
const arg = (process.argv[2] ?? "all").toLowerCase();
const targets = arg === "all"
  ? ALL_INSTALLERS
  : ALL_INSTALLERS.filter((i) => i.platform === arg);

if (targets.length === 0) {
  console.error(`❌  Unknown platform "${arg}". Use: linux, windows, mac, or all`);
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isCredentialsError(error) {
  const name = String(error?.name ?? "");
  const message = String(error?.message ?? error ?? "");
  return name.includes("CredentialsProviderError") || /credentials|could not be found/i.test(message);
}

/** Human-friendly failure for any S3 operation, with the right remedy per cause. */
function explainS3Error(error, context) {
  if (isCredentialsError(error)) {
    console.error(`❌  AWS rejected the credentials while ${context}: ${error?.message ?? error}`);
    printCredentialGuide();
    return;
  }
  const status = error?.$metadata?.httpStatusCode;
  if (status === 403) {
    console.error(`❌  Access denied while ${context} (HTTP 403) — the credentials were accepted but are not allowed on s3://${BUCKET.value}.`);
    console.error("    Check the bucket name, and that the key/user has s3:HeadObject + s3:PutObject permissions on it.");
    return;
  }
  if (status === 404) {
    console.error(`❌  Bucket not found while ${context} (HTTP 404) — s3://${BUCKET.value} does not exist in region ${REGION.value ?? "us-east-1"}.`);
    return;
  }
  console.error(`❌  Failed while ${context}: ${error?.message ?? error}`);
}

/** Does the file already exist in S3? Returns its size + last-modified, or null. */
async function findExisting(key) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET.value, Key: key }));
    return { size: head.ContentLength ?? 0, lastModified: head.LastModified ?? null };
  } catch (error) {
    const name = error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound" ? null : error?.name;
    if (name) {
      if (isCredentialsError(error) || error?.$metadata?.httpStatusCode === 403) {
        explainS3Error(error, `checking whether s3://${BUCKET.value}/${key} exists`);
        process.exit(1);
      }
      console.warn(`⚠️  existence check for s3://${BUCKET.value}/${key} failed (${name}) — uploading anyway`);
    }
    return null;
  }
}

// ── Upload ────────────────────────────────────────────────────────────────
async function upload({ platform, file, mime }) {
  const localPath = join(DIST_DIR, file);
  if (!existsSync(localPath)) {
    console.warn(`⚠️  [${platform}] ${file} not found at ${localPath} — skipping. Build it first with:`);
    console.warn(`     pnpm --filter @ai-qa/recorder dist --linux AppImage`);
    return;
  }

  const size = statSync(localPath).size;
  const key = `${S3_FOLDER}/${file}`;

  // Check whether the file already exists in the bucket — an existing object is
  // replaced with the latest local version below (PutObject overwrites in place).
  const existing = await findExisting(key);
  if (existing) {
    const uploaded = existing.lastModified ? existing.lastModified.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "unknown date";
    console.log(`🔍  [${platform}] ${key} already exists in s3://${BUCKET.value} (${formatSize(existing.size)}, uploaded ${uploaded})`);
    console.log(`    → replacing it with the latest local version (${formatSize(size)})`);
  } else {
    console.log(`🔍  [${platform}] ${key} does not exist in s3://${BUCKET.value} yet — uploading the local file`);
  }

  console.log(`⬆️  [${platform}] Uploading ${file} (${formatSize(size)}) → s3://${BUCKET.value}/${key}`);

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET.value,
        Key: key,
        Body: createReadStream(localPath),
        ContentType: mime,
        ContentLength: size,
        // No ACL — bucket uses BucketOwnerEnforced (ACLs disabled).
        // The API issues a presigned download URL so downloads work without public access.
      })
    );
  } catch (error) {
    explainS3Error(error, `uploading s3://${BUCKET.value}/${key}`);
    process.exit(1);
  }

  // Post-upload verification: the object now exists with the local file's size.
  const after = await findExisting(key);
  if (after && after.size === size) {
    console.log(`✅  [${platform}] Done — s3://${BUCKET.value}/${key} (${formatSize(after.size)})`);
  } else {
    console.log(`✅  [${platform}] Done — s3://${BUCKET.value}/${key}`);
  }
  console.log(`    The API serves this exact object (presigned URL) for the Recorder Setup modal downloads.`);
}

for (const target of targets) {
  await upload(target);
}
