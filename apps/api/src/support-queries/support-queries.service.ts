import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

const STATUSES = ["OPEN", "RESOLVED", "REJECTED"];

@Injectable()
export class SupportQueriesService {
  constructor(private readonly prisma: PrismaService) {}

  create(data: { title: string; description: string; email: string; imageUrl?: string | null }) {
    return this.prisma.supportQuery.create({ data });
  }

  list() {
    return this.prisma.supportQuery.findMany({ orderBy: { createdAt: "desc" } });
  }

  async updateStatus(id: string, status: string) {
    if (!STATUSES.includes(status)) throw new NotFoundException("Unknown support query status");
    const query = await this.prisma.supportQuery.findUnique({ where: { id } });
    if (!query) throw new NotFoundException("Support query not found");
    return this.prisma.supportQuery.update({ where: { id }, data: { status: status as never } });
  }
}
