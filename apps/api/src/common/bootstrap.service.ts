import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      const superadminEmail = "superadmin@proofline.local";
      const superadmin = await this.prisma.user.findUnique({ where: { email: superadminEmail } });
      if (!superadmin) {
        const bcrypt = await import("bcryptjs");
        const passwordHash = await bcrypt.hash(process.env.SUPERADMIN_PASSWORD ?? "superadmin-password-123", 12);
        await this.prisma.user.create({ data: { email: superadminEmail, displayName: "Platform Superadmin", passwordHash, isSuperadmin: true } });
        this.logger.log("Seeded platform superadmin account");
      }

      const organizations = await this.prisma.organization.findMany({ include: { subscription: true } });
      for (const organization of organizations) {
        if (!organization.subscription) {
          await this.prisma.subscription.create({ data: { organizationId: organization.id, status: "INCOMPLETE" } });
        }
      }
      // Placeholder customer ids from before real Stripe checkout existed.
      await this.prisma.subscription.updateMany({
        where: { OR: [{ stripeCustomerId: { startsWith: "local_" } }, { stripeCustomerId: { startsWith: "pending_" } }] },
        data: { stripeCustomerId: null }
      });
    } catch (error) {
      this.logger.error(`Bootstrap failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}
