import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Put, Res, UseGuards } from "@nestjs/common";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyReply } from "fastify";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { RecordingsService, type RecordEvent } from "./recordings.service";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard, RequirePermission } from "../rbac/permissions.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PERMISSIONS } from "@ai-qa/domain";

/** Public (no auth — plain <a href> downloads can't send headers): installer binaries.
 *
 *  Production (S3):  set AWS_S3_BUCKET_NAME (+ optionally AWS_S3_REGION) in .env and upload
 *    with `./scripts/upload-recorder-installers.sh all` (or `node scripts/upload-installer.mjs
 *    linux|windows|mac|all`). Each download request generates a short-lived presigned GET
 *    URL and redirects the browser to it — objects stay private, no bucket policy or ACL
 *    changes needed. The Recorder Setup modal's per-platform download buttons and curl
 *    commands all go through this route, so they always serve the exact file uploaded to
 *    the bucket's WebViewRecorder/ folder.
 *
 *  Local dev / self-hosted without S3: leave AWS_S3_BUCKET_NAME unset; files are streamed
 *    from apps/recorder/dist (or RECORDER_INSTALLER_DIR if set). */
const INSTALLER_FILES: Record<string, string> = {
  windows: "ProoflineRecorder-Setup.exe",
  mac:     "ProoflineRecorder.dmg",
  linux:   "ProoflineRecorder.AppImage",
};

/** S3 folder the upload script (scripts/upload-installer.mjs) pushes installers to —
 *  keep in sync with S3_FOLDER in that script. */
const S3_INSTALLER_PREFIX = "WebViewRecorder";

/** Lazy singleton — only created when S3 env vars are present. */
let s3: S3Client | null = null;
function getS3(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      region: process.env.AWS_S3_REGION ?? "us-east-1",
      credentials: process.env.AWS_ACCESS_KEY_ID
        ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! }
        : undefined, // falls back to IAM role / environment chain
    });
  }
  return s3;
}

@Controller("v1/recordings/installer")
export class RecorderInstallerController {
  @Get(":platform")
  async download(@Param("platform") platform: string, @Res() reply: FastifyReply) {
    const file = INSTALLER_FILES[platform];
    if (!file) throw new NotFoundException("Unknown platform — use windows, mac, or linux");

    // ── S3 presigned redirect (production) ────────────────────────────────
    // When AWS_S3_BUCKET_NAME is configured the API generates a 5-minute
    // presigned GET URL and issues a 302 redirect — no binary data flows
    // through the API process and objects remain private in S3.
    const bucket = process.env.AWS_S3_BUCKET_NAME;
    if (bucket) {
      const cmd = new GetObjectCommand({
        Bucket: bucket,
        Key: `${S3_INSTALLER_PREFIX}/${file}`,
        ResponseContentDisposition: `attachment; filename="${file}"`,
      });
      const url = await getSignedUrl(getS3(), cmd, { expiresIn: 300 }); // 5 min
      return reply.redirect(url, 302);
    }

    const dir = process.env.RECORDER_INSTALLER_DIR ?? resolve(__dirname, "../../../recorder/dist");
    const path = join(dir, file);
    if (!existsSync(path)) throw new NotFoundException(`The ${platform} installer has not been published yet. Ask your administrator to copy "${file}" to the server's installer directory.`);
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="${file}"`);
    reply.header("Content-Length", statSync(path).size);
    return reply.send(createReadStream(path));
  }
}

@UseGuards(AuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.TEST_CASES_CREATE)
@Controller("v1/projects/:projectId/recordings")
export class RecordingsController {
  constructor(private readonly recordingsService: RecordingsService) {}

  /** Creates the session and returns the deep link that opens the Proofline Recorder app. */
  @Post() start(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Body() body: { url?: string; apiUrl?: string }) {
    if (!body.url?.trim()) throw new BadRequestException("url is required");
    return this.recordingsService.start(user, projectId, body.url.trim(), body.apiUrl?.trim() ?? "");
  }

  /** The recorder desktop app announces that it opened the target URL. */
  @Post(":sessionId/attach") attach(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("sessionId") sessionId: string) {
    return this.recordingsService.attach(user, projectId, sessionId);
  }

  /** The recorder desktop app replaces the captured events (whole-list, last push wins). */
  @Put(":sessionId/events") pushEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: { events?: RecordEvent[]; screenshot?: string },
  ) {
    return this.recordingsService.pushEvents(user, projectId, sessionId, body.events ?? [], body.screenshot);
  }

  @Get(":sessionId") events(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("sessionId") sessionId: string) {
    return this.recordingsService.events(user, projectId, sessionId);
  }

  @Get(":sessionId/screenshot") screenshot(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("sessionId") sessionId: string) {
    return this.recordingsService.screenshot(user, projectId, sessionId);
  }

  @Post(":sessionId/stop") stop(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string, @Param("sessionId") sessionId: string) {
    return this.recordingsService.stop(user.organizationId, projectId, sessionId);
  }
}
