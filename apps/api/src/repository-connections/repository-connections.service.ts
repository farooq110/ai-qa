import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { recordAudit } from "../common/audit";

type ProviderName = "GITHUB" | "BITBUCKET" | "GITLAB";

const providerNames: ProviderName[] = ["GITHUB", "BITBUCKET", "GITLAB"];

interface OAuthState extends AuthenticatedUser { nonce: string }
interface TokenResponse { access_token?: string; error?: string; error_description?: string }
interface GithubUser { id: number; login: string }
interface GithubRepository { id: number; full_name: string; private: boolean; default_branch: string; html_url: string }
interface GithubBranch { name: string; commit: { sha: string } }
interface BitbucketUser { account_id: string; username: string; display_name: string }
interface BitbucketRepositories { values: Array<{ uuid: string; full_name: string; is_private: boolean; main_branch: string; links: { html: { href: string } } }> }
interface BitbucketBranches { values: Array<{ name: string; target: { hash: string } }> }
interface GitlabUser { id: number; username: string; name: string }
interface GitlabProject { id: number; path_with_namespace: string; visibility: string; default_branch: string | null; web_url: string }
interface GitlabBranch { name: string; commit: { id: string } }

@Injectable()
export class RepositoryConnectionsService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService, private readonly jwt: JwtService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.repositoryConnection.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, provider: true, accountLogin: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" }
    });
  }

  async disconnect(user: AuthenticatedUser, connectionId: string) {
    if (user.role !== "ADMIN") throw new ForbiddenException("Only organization admins can disconnect repository accounts");
    const connection = await this.prisma.repositoryConnection.findFirst({ where: { id: connectionId, organizationId: user.organizationId } });
    if (!connection) throw new NotFoundException("Connected account not found for this organization");
    await this.prisma.repositoryConnection.delete({ where: { id: connectionId } });
    await recordAudit(this.prisma, {
      organizationId: user.organizationId, actorId: user.userId, action: "repository.disconnected",
      targetType: "RepositoryConnection", targetId: connectionId, metadata: { provider: connection.provider, account: connection.accountLogin }
    });
    return { disconnected: true, provider: connection.provider, account: connection.accountLogin };
  }

  async authorizationUrl(user: AuthenticatedUser, provider: ProviderName) {
    const state = await this.jwt.signAsync({ ...user, nonce: randomBytes(16).toString("hex") } satisfies OAuthState, { expiresIn: "10m" });
    const callbackUrl = this.callbackUrl(provider);
    if (provider === "GITHUB") {
      const clientId = this.requireConfig("GITHUB_CLIENT_ID", provider);
      const parameters = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl, scope: "read:user repo", state });
      return { url: `https://github.com/login/oauth/authorize?${parameters}` };
    }
    if (provider === "BITBUCKET") {
      const clientId = this.requireConfig("BITBUCKET_CLIENT_ID", provider);
      const parameters = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl, response_type: "code", state });
      return { url: `https://bitbucket.org/site/oauth2/authorize?${parameters}` };
    }
    const clientId = this.requireConfig("GITLAB_CLIENT_ID", provider);
    const parameters = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl, response_type: "code", state, scope: "read_user read_api" });
    return { url: `https://gitlab.com/oauth/authorize?${parameters}` };
  }

  async completeConnection(provider: ProviderName, code: string, state: string) {
    const oauthState = await this.jwt.verifyAsync<OAuthState>(state);
    if (provider === "GITHUB") {
      const accessToken = await this.exchangeGithub(code);
      const profile = await this.githubRequest<GithubUser>(accessToken, "https://api.github.com/user");
      return this.saveConnection(oauthState, provider, String(profile.id), profile.login, accessToken);
    }
    if (provider === "BITBUCKET") {
      const accessToken = await this.exchangeBitbucket(code);
      const profile = await this.bitbucketRequest<BitbucketUser>(accessToken, "https://api.bitbucket.org/2.0/user");
      return this.saveConnection(oauthState, provider, profile.account_id, profile.username, accessToken);
    }
    const accessToken = await this.exchangeGitlab(code);
    const profile = await this.gitlabRequest<GitlabUser>(accessToken, "https://gitlab.com/api/v4/user");
    return this.saveConnection(oauthState, provider, String(profile.id), profile.username, accessToken);
  }

  async listRepositories(user: AuthenticatedUser, provider: ProviderName) {
    const accessToken = await this.providerToken(user.organizationId, provider);
    if (provider === "GITHUB") {
      const repositories = await this.githubRequest<GithubRepository[]>(accessToken, "https://api.github.com/user/repos?per_page=100&sort=updated");
      return repositories.map((repository) => ({ externalId: String(repository.id), fullName: repository.full_name, private: repository.private, defaultBranch: repository.default_branch, url: repository.html_url }));
    }
    if (provider === "BITBUCKET") {
      const page = await this.bitbucketRequest<BitbucketRepositories>(accessToken, "https://api.bitbucket.org/2.0/repositories?role=contributor&pagelen=100");
      return page.values.map((repository) => ({ externalId: repository.uuid, fullName: repository.full_name, private: repository.is_private, defaultBranch: repository.main_branch, url: repository.links.html.href }));
    }
    const projects = await this.gitlabRequest<GitlabProject[]>(accessToken, "https://gitlab.com/api/v4/projects?membership=true&per_page=100&order_by=updated_at");
    return projects.map((project) => ({ externalId: String(project.id), fullName: project.path_with_namespace, private: project.visibility !== "public", defaultBranch: project.default_branch ?? "main", url: project.web_url }));
  }

  async listBranches(user: AuthenticatedUser, provider: ProviderName, repository: string) {
    if (provider !== "GITLAB" && !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new BadRequestException("repository must be in owner/name format");
    const accessToken = await this.providerToken(user.organizationId, provider);
    if (provider === "GITHUB") {
      const branches = await this.githubRequest<GithubBranch[]>(accessToken, `https://api.github.com/repos/${repository}/branches?per_page=100`);
      return branches.map((branch) => ({ name: branch.name, commitSha: branch.commit.sha }));
    }
    if (provider === "BITBUCKET") {
      const page = await this.bitbucketRequest<BitbucketBranches>(accessToken, `https://api.bitbucket.org/2.0/repositories/${repository}/refs/branches?pagelen=100`);
      return page.values.map((branch) => ({ name: branch.name, commitSha: branch.target.hash }));
    }
    const branches = await this.gitlabRequest<GitlabBranch[]>(accessToken, `https://gitlab.com/api/v4/projects/${encodeURIComponent(repository)}/repository/branches?per_page=100`);
    return branches.map((branch) => ({ name: branch.name, commitSha: branch.commit.id }));
  }

  /** Preferred token lookup: exact provider connection, newest first. */
  async providerToken(organizationId: string, provider: ProviderName) {
    const connection = await this.prisma.repositoryConnection.findFirst({ where: { organizationId, provider }, orderBy: { updatedAt: "desc" } });
    if (!connection) throw new NotFoundException(`No ${provider.toLowerCase()} account is connected to this organization`);
    return this.decrypt(connection);
  }

  /** Kept for the analysis pipeline, which currently speaks the GitHub API. */
  async githubToken(organizationId: string) {
    return this.providerToken(organizationId, "GITHUB");
  }

  private async saveConnection(oauthState: OAuthState, provider: ProviderName, externalAccountId: string, accountLogin: string, accessToken: string) {
    const encrypted = this.encrypt(accessToken);
    await this.prisma.repositoryConnection.upsert({
      where: { organizationId_provider_externalAccountId: { organizationId: oauthState.organizationId, provider, externalAccountId } },
      create: { organizationId: oauthState.organizationId, provider, externalAccountId, accountLogin, ...encrypted },
      update: { accountLogin, ...encrypted }
    });
    await recordAudit(this.prisma, {
      organizationId: oauthState.organizationId, actorId: oauthState.userId, action: "repository.connected",
      targetType: "RepositoryConnection", metadata: { provider, account: accountLogin }
    });
    return { provider, account: accountLogin };
  }

  private async exchangeGithub(code: string) {
    const clientId = this.requireConfig("GITHUB_CLIENT_ID", "GITHUB");
    const clientSecret = this.requireConfig("GITHUB_CLIENT_SECRET", "GITHUB");
    const response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }) });
    return this.extractToken(response, "GitHub");
  }

  private async exchangeBitbucket(code: string) {
    const clientId = this.requireConfig("BITBUCKET_CLIENT_ID", "BITBUCKET");
    const clientSecret = this.requireConfig("BITBUCKET_CLIENT_SECRET", "BITBUCKET");
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await fetch("https://bitbucket.org/site/oauth2/access_token", { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code }) });
    return this.extractToken(response, "Bitbucket");
  }

  private async exchangeGitlab(code: string) {
    const clientId = this.requireConfig("GITLAB_CLIENT_ID", "GITLAB");
    const clientSecret = this.requireConfig("GITLAB_CLIENT_SECRET", "GITLAB");
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: this.callbackUrl("GITLAB") });
    const response = await fetch("https://gitlab.com/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    return this.extractToken(response, "GitLab");
  }

  private async extractToken(response: Response, providerLabel: string) {
    const payload = await response.json() as TokenResponse;
    if (!response.ok || !payload.access_token) throw new BadRequestException(payload.error_description ?? `${providerLabel} did not grant an access token`);
    return payload.access_token;
  }

  private requireConfig(key: string, provider: ProviderName) {
    const value = this.config.get<string>(key);
    if (!value) throw new BadRequestException(`${provider.charAt(0)}${provider.slice(1).toLowerCase()} OAuth is not configured on this deployment (missing ${key})`);
    return value;
  }

  private callbackUrl(provider: ProviderName) {
    const envKey = provider === "GITHUB" ? "GITHUB_CALLBACK_URL" : provider === "BITBUCKET" ? "BITBUCKET_CALLBACK_URL" : "GITLAB_CALLBACK_URL";
    return this.config.get<string>(envKey) ?? `http://localhost:4000/v1/repository-connections/${provider.toLowerCase()}/callback`;
  }

  private async githubRequest<T>(token: string, url: string) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "proofline-local" } });
    if (!response.ok) throw new BadRequestException(`GitHub API request failed with status ${response.status}`);
    return response.json() as Promise<T>;
  }

  private async bitbucketRequest<T>(token: string, url: string) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!response.ok) throw new BadRequestException(`Bitbucket API request failed with status ${response.status}`);
    return response.json() as Promise<T>;
  }

  private async gitlabRequest<T>(token: string, url: string) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new BadRequestException(`GitLab API request failed with status ${response.status}`);
    return response.json() as Promise<T>;
  }

  private encrypt(value: string) {
    const key = this.encryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { accessTokenCiphertext: ciphertext.toString("base64"), accessTokenIv: iv.toString("base64"), accessTokenTag: cipher.getAuthTag().toString("base64") };
  }

  private decrypt(connection: { accessTokenCiphertext: string; accessTokenIv: string; accessTokenTag: string }) {
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey(), Buffer.from(connection.accessTokenIv, "base64"));
    decipher.setAuthTag(Buffer.from(connection.accessTokenTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(connection.accessTokenCiphertext, "base64")), decipher.final()]).toString("utf8");
  }

  private encryptionKey() {
    return createHash("sha256").update(this.config.getOrThrow<string>("JWT_SECRET")).digest();
  }
}

export function assertProviderName(provider: string): ProviderName {
  const upper = provider.toUpperCase();
  if (!providerNames.includes(upper as ProviderName)) throw new BadRequestException("provider must be github, bitbucket, or gitlab");
  return upper as ProviderName;
}
