import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

const planSeeds = [
  { key: "trial", name: "Trial", monthlyPriceUsd: 0, tokenQuotaMonthly: 1_000_000, warningThresholdPct: 80, executionSlotLimit: 5, retentionDays: 14 },
  { key: "starter", name: "Starter", monthlyPriceUsd: 49, tokenQuotaMonthly: 2_000_000, warningThresholdPct: 80, executionSlotLimit: 5, retentionDays: 30 },
  { key: "team", name: "Team", monthlyPriceUsd: 149, tokenQuotaMonthly: 8_000_000, warningThresholdPct: 85, executionSlotLimit: 25, retentionDays: 60 },
  { key: "business", name: "Business", monthlyPriceUsd: 449, tokenQuotaMonthly: 25_000_000, warningThresholdPct: 90, executionSlotLimit: 100, retentionDays: 90 }
];

@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      for (const plan of planSeeds) {
        await this.prisma.pricingPlan.upsert({ where: { key: plan.key }, create: plan, update: {} });
      }

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
          const trial = await this.prisma.pricingPlan.findUnique({ where: { key: "trial" } });
          await this.prisma.subscription.create({
            data: { organizationId: organization.id, stripeCustomerId: `local_${organization.id}`, planId: trial?.id, status: "TRIALING" }
          });
        }
      }
    } catch (error) {
      this.logger.error(`Bootstrap failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}
