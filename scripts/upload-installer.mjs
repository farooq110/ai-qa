#!/usr/bin/env node
/**
 * Upload Proofline Recorder installers to S3.
 *
 * Usage:
 *   node scripts/upload-installer.js [linux|windows|mac|all]
 *
 * Defaults to "all" if no argument is given (only uploads files that exist).
 *
 * Reads credentials from the root .env file:
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   AWS_S3_BUCKET_NAME
 *   AWS_S3_REGION
 *
 * Files are stored under the "installers/" prefix as private objects.
 * The API generates a short-lived presigned GET URL on each download request
 * (using @aws-sdk/s3-request-presigner, already installed in apps/api),
 * so no bucket-level public access is required.
 *
 * e.g. s3://agentic-qa-proofline-dev/installers/ProoflineRecorder.AppImage
 */

import { readFileSync, createReadStream, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Resolve @aws-sdk from the API package where it is installed in the pnpm workspace.
const apiDir = join(ROOT, "apps", "api");
const require = createRequire(pathToFileURL(join(apiDir, "package.json")));
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// ── Load .env ──────────────────────────────────────────────────────────────
function loadEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const env = {};
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = { ...loadEnv(join(ROOT, ".env")), ...process.env };

const BUCKET = env.AWS_S3_BUCKET_NAME;
const REGION = env.AWS_S3_REGION ?? "us-east-1";
const ACCESS_KEY = env.AWS_ACCESS_KEY_ID;
const SECRET_KEY = env.AWS_SECRET_ACCESS_KEY;

if (!BUCKET || !ACCESS_KEY || !SECRET_KEY) {
  console.error(
    "❌  Missing required env vars. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_S3_BUCKET_NAME in .env"
  );
  process.exit(1);
}

const s3 = new S3Client({
  region: REGION,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

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

// ── Upload ────────────────────────────────────────────────────────────────
async function upload({ platform, file, mime }) {
  const localPath = join(DIST_DIR, file);
  if (!existsSync(localPath)) {
    console.warn(`⚠️  [${platform}] ${file} not found at ${localPath} — skipping. Build it first with:`);
    console.warn(`     pnpm --filter @ai-qa/recorder dist --linux AppImage`);
    return;
  }

  const size = statSync(localPath).size;
  const key = `installers/${file}`;
  console.log(`⬆️  [${platform}] Uploading ${file} (${(size / 1024 / 1024).toFixed(1)} MB) → s3://${BUCKET}/${key}`);

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: createReadStream(localPath),
      ContentType: mime,
      ContentLength: size,
      // No ACL — bucket uses BucketOwnerEnforced (ACLs disabled).
      // The API issues a presigned GET URL so downloads work without public access.
    })
  );

  console.log(`✅  [${platform}] Done — s3://${BUCKET}/${key}`);
  console.log(`    The API will generate a presigned download URL on each request.`);
}

for (const target of targets) {
  await upload(target);
}
