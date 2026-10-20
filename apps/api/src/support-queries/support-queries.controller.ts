import { BadRequestException, Body, Controller, Post, ServiceUnavailableException } from "@nestjs/common";
import { SupportQueriesService } from "./support-queries.service";
import { createPresignedUpload } from "./s3";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Public — the landing page's contact modal posts here server-to-server, before the visitor has any account. */
@Controller("v1/support-queries")
export class SupportQueriesController {
  constructor(private readonly supportQueries: SupportQueriesService) {}

  @Post("presigned-upload")
  async presignedUpload(@Body() body: { contentType?: string }) {
    if (!body.contentType?.startsWith("image/")) throw new BadRequestException("contentType must be an image type");
    const presigned = await createPresignedUpload(body.contentType);
    if (!presigned) throw new ServiceUnavailableException("S3 isn't configured yet");
    return presigned;
  }

  @Post()
  create(@Body() body: { title?: string; description?: string; email?: string; imageUrl?: string }) {
    const title = body.title?.trim();
    const description = body.description?.trim();
    const email = body.email?.trim();
    if (!title || !description || !email || !EMAIL_RE.test(email)) {
      throw new BadRequestException("title, description, and a valid email are required");
    }
    return this.supportQueries.create({ title, description, email, imageUrl: body.imageUrl?.trim() || null });
  }
}
