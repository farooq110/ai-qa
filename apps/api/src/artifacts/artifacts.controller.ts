import { Controller, Get, NotFoundException, Param, Res, UseGuards } from "@nestjs/common";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { FastifyReply } from "fastify";
import { join } from "node:path";
import { AuthGuard } from "../auth/auth.guard";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";

@UseGuards(AuthGuard)
@Controller("v1/artifacts")
export class ArtifactsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(":artifactId")
  async download(@CurrentUser() user: AuthenticatedUser, @Param("artifactId") artifactId: string, @Res() reply: FastifyReply) {
    const artifact = await this.prisma.artifact.findFirst({
      where: { id: artifactId, executionPlan: { organizationId: user.organizationId } }
    });
    if (!artifact) throw new NotFoundException("Artifact not found");
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
