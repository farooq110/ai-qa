import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../database/prisma.service";
import type { AccessTokenPayload } from "./auth.types";

interface SignUpInput { email: string; password: string; displayName: string; organizationName: string; industry?: string; organizationSize?: string; country?: string; }
interface SignInInput { email: string; password: string; }

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly jwtService: JwtService) {}

  async signUp(input: SignUpInput) {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException("An account with this email already exists");

    const passwordHash = await bcrypt.hash(input.password, 12);
    const trialPlan = await this.prisma.pricingPlan.findUnique({ where: { key: "trial" } });
    const user = await this.prisma.user.create({
      data: {
        email,
        displayName: input.displayName.trim(),
        passwordHash,
        membership: {
          create: {
            role: "ADMIN",
            organization: {
              create: {
                name: input.organizationName.trim(),
                industry: input.industry?.trim() || undefined,
                organizationSize: input.organizationSize?.trim() || undefined,
                country: input.country?.trim() || undefined,
                subscription: { create: { stripeCustomerId: `pending_${Date.now()}`, planId: trialPlan?.id, status: "TRIALING" } }
              }
            }
          }
        }
      },
      include: { membership: { include: { organization: true } } }
    });

    if (user.membership) {
      await this.prisma.subscription.updateMany({ where: { organizationId: user.membership.organizationId, stripeCustomerId: { startsWith: "pending_" } }, data: { stripeCustomerId: `local_${user.membership.organizationId}` } });
    }

    return this.issueSession(user.id, user.membership!.organizationId, user.membership!.role, user.membership!.organization.name, user.isSuperadmin);
  }

  async signIn(input: SignInInput) {
    const emails = await this.prisma.user.findMany();
    console.log("Existing emails in the database:", emails.map(user => user.email));
    const user = await this.prisma.user.findUnique({ where: { email: input.email.trim().toLowerCase() }, include: { membership: { include: { organization: true } } } });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) throw new UnauthorizedException("Invalid email or password");
    if (!user.isSuperadmin && !user.membership) throw new UnauthorizedException("This account has no organization membership");
    return this.issueSession(user.id, user.membership?.organizationId ?? "", user.membership?.role ?? "ADMIN", user.membership?.organization.name ?? "", user.isSuperadmin);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { membership: { include: { organization: { include: { subscription: { include: { plan: true } } } } } } } });
    if (!user) throw new UnauthorizedException("Account no longer exists");
    const organization = user.membership?.organization;
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      isSuperadmin: user.isSuperadmin,
      role: user.membership?.role ?? null,
      organization: organization ? {
        id: organization.id,
        name: organization.name,
        industry: organization.industry,
        organizationSize: organization.organizationSize,
        country: organization.country,
        subscription: organization.subscription ? {
          status: organization.subscription.status,
          currentPeriodEnd: organization.subscription.currentPeriodEnd,
          plan: organization.subscription.plan ? { key: organization.subscription.plan.key, name: organization.subscription.plan.name, tokenQuotaMonthly: organization.subscription.plan.tokenQuotaMonthly, executionSlotLimit: organization.subscription.plan.executionSlotLimit } : null
        } : null
      } : null
    };
  }

  private async issueSession(userId: string, organizationId: string, role: AccessTokenPayload["role"], organizationName: string, isSuperadmin = false) {
    const payload: AccessTokenPayload = { sub: userId, userId, organizationId, role };
    return { accessToken: await this.jwtService.signAsync(payload), organization: { id: organizationId, name: organizationName }, role, isSuperadmin };
  }
}
