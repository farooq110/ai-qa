import { Controller, Get, NotFoundException, Param, Res, UseGuards } from "@nestjs/common";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { FastifyReply } from "fastify";
import { join } from "node:path";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { AuthGuard } from "../auth/auth.guard";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";

@UseGuards(AuthGuard)
@Controller("v1/artifacts")
export class ArtifactsController {
  private readonly s3: S3Client | null;

  constructor(private readonly prisma: PrismaService) {
    this.s3 = process.env.AWS_S3_BUCKET_NAME && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? new S3Client({ region: process.env.AWS_S3_REGION ?? "us-east-1" })
      : null;
  }

  @Get(":artifactId")
  async download(@CurrentUser() user: AuthenticatedUser, @Param("artifactId") artifactId: string, @Res() reply: FastifyReply) {
    const artifact = await this.prisma.artifact.findFirst({
      where: { id: artifactId, executionPlan: { organizationId: user.organizationId } }
    });
    if (!artifact) throw new NotFoundException("Artifact not found");

    // S3-stored artifacts stream through the API (a redirect to a presigned URL
    // would be blocked by the browser — the UI's fetch() follows it cross-origin
    // without CORS headers and fails with "Failed to fetch").
    if (artifact.storage === "s3") {
      if (!this.s3) throw new NotFoundException("Artifact is in S3 but AWS is not configured");
      const object = await this.s3.send(new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET_NAME, Key: artifact.path }));
      reply.header("Content-Type", object.ContentType ?? artifact.contentType);
      if (object.ContentLength) reply.header("Content-Length", object.ContentLength);
      reply.header("Content-Disposition", `inline; filename="${artifact.path.split("/").pop()}"`);
      return reply.send(object.Body);
    }

    const filePath = join(process.env.ARTIFACT_DIR ?? join(process.cwd(), "artifacts"), artifact.path);
    if (!existsSync(filePath)) throw new NotFoundException("Artifact file is no longer available");
    const size = statSync(filePath).size;
    reply.header("Content-Type", artifact.contentType);
    reply.header("Content-Length", size);
    reply.header("Content-Disposition", `inline; filename="${artifact.path.split(/[\\/]/).pop()}"`);
    // With Fastify the stream must be sent explicitly; returning it leaves the
    // response open forever (observed as an endless "Loading artifact…").
    return reply.send(createReadStream(filePath));
  }
}
