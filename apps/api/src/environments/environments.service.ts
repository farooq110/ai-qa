import type { RouteFixtures } from "@ai-qa/test-dsl";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { encryptField } from "../common/crypto.util";

interface CredentialInput {
  loginUrl?: string;
  loginTrigger?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  username?: string;
  password?: string;
  routeFixtures?: RouteFixtures | null;
}

@Injectable()
export class EnvironmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser, projectId: string) {
    await this.assertProject(user, projectId);
    const environments = await this.prisma.environmentProfile.findMany({ where: { projectId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
    // Secrets never leave the API — only whether credentials are configured.
    return environments.map((environment) => this.toDto(environment));
  }

  async create(user: AuthenticatedUser, projectId: string, input: { name: string; url: string; isDefault?: boolean } & CredentialInput) {
    await this.assertProject(user, projectId);
    const name = input.name.trim();
    const existing = await this.prisma.environmentProfile.findUnique({ where: { projectId_name: { projectId, name } } });
    if (existing) throw new BadRequestException("An environment with this name already exists on the project");
    if (input.isDefault) await this.prisma.environmentProfile.updateMany({ where: { projectId }, data: { isDefault: false } });
    const count = await this.prisma.environmentProfile.count({ where: { projectId } });
    return this.toDto(await this.prisma.environmentProfile.create({
      data: {
        projectId,
        name,
        url: input.url.trim(),
        isDefault: input.isDefault || count === 0,
        ...this.credentialFields(input)
      }
    }));
  }

  async update(user: AuthenticatedUser, projectId: string, environmentId: string, input: { name?: string; url?: string; isDefault?: boolean } & CredentialInput) {
    await this.assertProject(user, projectId);
    const environment = await this.prisma.environmentProfile.findFirst({ where: { id: environmentId, projectId } });
    if (!environment) throw new NotFoundException("Environment not found");
    if (input.isDefault) await this.prisma.environmentProfile.updateMany({ where: { projectId }, data: { isDefault: false } });
    const updated = await this.prisma.environmentProfile.update({
      where: { id: environmentId },
      data: {
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(input.url?.trim() ? { url: input.url.trim() } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        ...this.credentialFields(input)
      }
    });
    return this.toDto(updated);
  }

  async setDefault(user: AuthenticatedUser, projectId: string, environmentId: string) {
    await this.assertProject(user, projectId);
    const environment = await this.prisma.environmentProfile.findFirst({ where: { id: environmentId, projectId } });
    if (!environment) throw new NotFoundException("Environment not found");
    await this.prisma.environmentProfile.updateMany({ where: { projectId }, data: { isDefault: false } });
    return this.toDto(await this.prisma.environmentProfile.update({ where: { id: environmentId }, data: { isDefault: true } }));
  }

  async delete(user: AuthenticatedUser, projectId: string, environmentId: string) {
    await this.assertProject(user, projectId);
    const environment = await this.prisma.environmentProfile.findFirst({ where: { id: environmentId, projectId } });
    if (!environment) throw new NotFoundException("Environment not found");
    await this.prisma.environmentProfile.delete({ where: { id: environmentId } });
    if (environment.isDefault) {
      const next = await this.prisma.environmentProfile.findFirst({ where: { projectId }, orderBy: { name: "asc" } });
      if (next) await this.prisma.environmentProfile.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    return { deleted: true };
  }

  private credentialFields(input: CredentialInput) {
    const secret = process.env.JWT_SECRET ?? "";
    const wantsCredentials = input.username !== undefined || input.password !== undefined;
    const fixtures = input.routeFixtures === undefined ? {} : { routeFixtures: input.routeFixtures ?? Prisma.DbNull };
    if (!wantsCredentials) {
      return {
        ...fixtures,
        ...(input.loginUrl !== undefined ? { loginUrl: input.loginUrl.trim() || null } : {}),
        ...(input.loginTrigger !== undefined ? { loginTriggerSelector: input.loginTrigger.trim() || null } : {}),
        ...(input.usernameSelector !== undefined ? { usernameSelector: input.usernameSelector.trim() || null } : {}),
        ...(input.passwordSelector !== undefined ? { passwordSelector: input.passwordSelector.trim() || null } : {}),
        ...(input.submitSelector !== undefined ? { submitSelector: input.submitSelector.trim() || null } : {})
      };
    }
    if (!input.username || !input.password) throw new BadRequestException("Both username and password are required to save credentials");
    const username = encryptField(input.username, secret);
    const password = encryptField(input.password, secret);
    return {
      ...fixtures,
      loginUrl: input.loginUrl?.trim() || null,
      loginTriggerSelector: input.loginTrigger?.trim() || null,
      usernameSelector: input.usernameSelector?.trim() || null,
      passwordSelector: input.passwordSelector?.trim() || null,
      submitSelector: input.submitSelector?.trim() || null,
      usernameEnc: username.enc, usernameIv: username.iv, usernameTag: username.tag,
      passwordEnc: password.enc, passwordIv: password.iv, passwordTag: password.tag
    };
  }

  private toDto(environment: {
    id: string; name: string; url: string; isDefault: boolean;
    usernameEnc: string | null; passwordEnc: string | null; loginUrl: string | null; routeFixtures: unknown;
  }) {
    return {
      id: environment.id,
      name: environment.name,
      url: environment.url,
      isDefault: environment.isDefault,
      loginUrl: environment.loginUrl,
      hasCredentials: Boolean(environment.usernameEnc && environment.passwordEnc),
      routeFixtures: (environment.routeFixtures ?? {}) as RouteFixtures
    };
  }

  private async assertProject(user: AuthenticatedUser, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
  }
}
