import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import { MailService } from "../mail/mail.service";
import { recordAudit } from "../common/audit";
import { effectiveStatus, trialDaysLeft } from "../common/billing-context";
import { passwordChangedTemplate, resetPasswordTemplate, verifyEmailTemplate, welcomeTemplate } from "../mail/templates";
import { APP_ROLES } from "@ai-qa/domain";
import { PermissionsService } from "../rbac/permissions.service";
import type { AccessTokenPayload } from "./auth.types";

interface SignUpInput { email: string; password: string; displayName: string; organizationName: string; industry?: string; organizationSize?: string; country?: string; }
interface SignInInput { email: string; password: string; }
type EmailTokenPurpose = "verify-email" | "reset-password";
interface EmailTokenPayload { sub: string; email: string; pwd?: string; }

const webUrl = () => (process.env.WEB_APP_URL ?? "http://localhost:3004").replace(/\/$/, "");
/** Separate secret per purpose, so an email link can never pass as an access token (or as the other link). */
const emailTokenSecret = (purpose: EmailTokenPurpose) => `${process.env.JWT_SECRET}:${purpose}`;
/** Fingerprint of the current password hash: a reset link dies as soon as the password changes, which makes it single-use. */
const passwordFingerprint = (passwordHash: string) => createHash("sha256").update(passwordHash).digest("base64url").slice(0, 16);

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly jwtService: JwtService, private readonly mail: MailService, private readonly permissions: PermissionsService) {}

  async signUp(input: SignUpInput) {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException("An account with this email already exists");

    // Every new organization starts on the 7-day Free Trial plan (superadmin-configurable length).
    const trialPlan = await this.prisma.pricingPlan.findUnique({ where: { key: "trial" } });
    const trialDays = trialPlan?.trialDays ?? 7;
    const now = new Date();
    const trialEnd = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email,
        displayName: input.displayName.trim(),
        passwordHash,
        membership: {
          create: {
            role: APP_ROLES.ADMIN,
            organization: {
              create: {
                name: input.organizationName.trim(),
                industry: input.industry?.trim() || undefined,
                organizationSize: input.organizationSize?.trim() || undefined,
                country: input.country?.trim() || undefined,
                subscription: {
                  create: trialPlan ? {
                    status: "TRIALING",
                    planId: trialPlan.id,
                    currentPeriodEnd: trialEnd
                  } : { status: "INCOMPLETE" }
                }
              }
            }
          }
        }
      },
      include: { membership: { include: { organization: true } } }
    });

    await this.sendVerification(user, user.membership!.organization.name);
    return { verificationRequired: true, email };
  }

  async signIn(input: SignInInput) {
    const user = await this.prisma.user.findUnique({ where: { email: input.email.trim().toLowerCase() }, include: { membership: { include: { organization: true } } } });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) throw new UnauthorizedException("Invalid email or password");
    if (!user.isSuperadmin && !user.membership) throw new UnauthorizedException("This account has no organization membership");
    if (!user.isSuperadmin && !user.emailVerifiedAt) throw new ForbiddenException({ message: "Confirm your email before signing in. Check your inbox for the link.", code: "EMAIL_NOT_VERIFIED" });
    return this.issueSession(user.id, user.membership?.organizationId ?? "", user.membership?.role as APP_ROLES, user.membership?.organization.name ?? "", user.isSuperadmin);
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
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt,
      role: user.membership?.role ?? null,
      permissions: user.membership ? await this.permissions.forRole(user.membership.organizationId, user.membership.role as APP_ROLES) : [],
      organization: organization ? {
        id: organization.id,
        name: organization.name,
        industry: organization.industry,
        organizationSize: organization.organizationSize,
        country: organization.country,
        subscription: organization.subscription ? {
          status: effectiveStatus(organization.subscription),
          trialDaysLeft: trialDaysLeft(organization.subscription),
          currentPeriodEnd: organization.subscription.currentPeriodEnd,
          plan: organization.subscription.plan ? { key: organization.subscription.plan.key, name: organization.subscription.plan.name, tokenQuotaMonthly: organization.subscription.plan.tokenQuotaMonthly, executionSlotLimit: organization.subscription.plan.executionSlotLimit } : null
        } : null
      } : null
    };
  }

  async resendVerification(rawEmail: string) {
    const user = await this.prisma.user.findUnique({ where: { email: rawEmail.trim().toLowerCase() }, include: { membership: { include: { organization: true } } } });
    // Same response whether or not the account exists, so this can't be used to probe for emails.
    if (user && !user.emailVerifiedAt && user.membership) await this.sendVerification(user, user.membership.organization.name);
    return { ok: true };
  }

  async verifyEmail(token: string) {
    const payload = await this.readEmailToken(token, "verify-email");
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, include: { membership: { include: { organization: true } } } });
    if (!user || user.email !== payload.email || !user.membership) throw new BadRequestException("This confirmation link is no longer valid. Request a new one.");
    // Already confirmed: don't let a replayed link sign anyone in. The person signs in normally.
    if (user.emailVerifiedAt) return { alreadyVerified: true };

    await this.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    const organizationName = user.membership.organization.name;
    await this.mail.send(user.email, welcomeTemplate({ displayName: user.displayName, email: user.email, organizationName, url: `${webUrl()}/dashboard` }));
    return this.issueSession(user.id, user.membership.organizationId, user.membership.role as APP_ROLES, organizationName, user.isSuperadmin);
  }

  async forgotPassword(rawEmail: string) {
    const user = await this.prisma.user.findUnique({ where: { email: rawEmail.trim().toLowerCase() } });
    if (user) {
      const token = await this.jwtService.signAsync({ sub: user.id, email: user.email, pwd: passwordFingerprint(user.passwordHash) } satisfies EmailTokenPayload, { secret: emailTokenSecret("reset-password"), expiresIn: "1h" });
      await this.mail.send(user.email, resetPasswordTemplate({ displayName: user.displayName, email: user.email, url: `${webUrl()}/reset-password?token=${token}` }));
    }
    // Same response whether or not the account exists.
    return { ok: true };
  }

  async resetPassword(token: string, password: string) {
    const payload = await this.readEmailToken(token, "reset-password");
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.email !== payload.email || payload.pwd !== passwordFingerprint(user.passwordHash)) throw new BadRequestException("This reset link has already been used or is no longer valid. Request a new one.");
    // Following the emailed link proves inbox ownership, so it also confirms the email.
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 12), emailVerifiedAt: user.emailVerifiedAt ?? new Date() } });
    await this.mail.send(user.email, passwordChangedTemplate({ displayName: user.displayName, email: user.email, url: `${webUrl()}/forgot-password` }));
    return { ok: true };
  }

  async updateProfile(userId: string, input: { displayName: string }) {
    await this.prisma.user.update({ where: { id: userId }, data: { displayName: input.displayName.trim() } });
    return this.me(userId);
  }

  async changePassword(actor: { userId: string; organizationId: string }, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId } });
    if (!user) throw new UnauthorizedException("Account no longer exists");
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw new BadRequestException("Your current password is incorrect.");
    if (currentPassword === newPassword) throw new BadRequestException("Choose a password you aren't already using.");
    // A new hash also invalidates any outstanding reset links (see passwordFingerprint).
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, 12) } });
    await recordAudit(this.prisma, { organizationId: actor.organizationId || null, actorId: user.id, actorEmail: user.email, action: "user.password_changed", targetType: "User", targetId: user.id });
    await this.mail.send(user.email, passwordChangedTemplate({ displayName: user.displayName, email: user.email, url: `${webUrl()}/forgot-password` }));
    return { ok: true };
  }

  private async sendVerification(user: { id: string; email: string; displayName: string }, organizationName: string) {
    const token = await this.jwtService.signAsync({ sub: user.id, email: user.email } satisfies EmailTokenPayload, { secret: emailTokenSecret("verify-email"), expiresIn: "24h" });
    await this.mail.send(user.email, verifyEmailTemplate({ displayName: user.displayName, email: user.email, organizationName, url: `${webUrl()}/verify-email?token=${token}` }));
  }

  private async readEmailToken(token: string, purpose: EmailTokenPurpose) {
    try {
      return await this.jwtService.verifyAsync<EmailTokenPayload>(token, { secret: emailTokenSecret(purpose) });
    } catch {
      throw new BadRequestException(purpose === "verify-email" ? "This confirmation link has expired. Request a new one." : "This reset link has expired. Request a new one.");
    }
  }

  private async issueSession(userId: string, organizationId: string, role: AccessTokenPayload["role"], organizationName: string, isSuperadmin = false) {
    const payload: AccessTokenPayload = { sub: userId, userId, organizationId, role };
    return { accessToken: await this.jwtService.signAsync(payload), organization: { id: organizationId, name: organizationName }, role, isSuperadmin };
  }
}
