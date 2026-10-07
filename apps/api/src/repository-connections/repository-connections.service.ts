import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { recordAudit } from "../common/audit";

type ProviderName = "GITHUB" | "BITBUCKET" | "GITLAB";

const providerNames: ProviderName[] = ["GITHUB", "BITBUCKET", "GITLAB"];

/** Refresh this long before expiry so in-flight API calls never race the clock. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

interface OAuthState extends AuthenticatedUser { nonce: string }
interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
type ProviderTokens = { accessToken: string; refreshToken?: string; expiresIn?: number };
interface GithubUser { id: number; login: string }
interface GithubRepository { id: number; full_name: string; private: boolean; default_branch: string; html_url: string }
interface GithubBranch { name: string; commit: { sha: string } }
interface BitbucketUser { account_id: string; username: string; display_name: string }
interface BitbucketRepositories { values: Array<{ uuid: string; full_name: string; is_private: boolean; mainbranch?: { name?: string }; links: { html: { href: string } } }> }
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
      const tokens = await this.exchangeGithub(code);
      const profile = await this.githubRequest<GithubUser>(tokens.accessToken, "https://api.github.com/user");
      return this.saveConnection(oauthState, provider, String(profile.id), profile.login, tokens);
    }
    if (provider === "BITBUCKET") {
      const tokens = await this.exchangeBitbucket(code);
      const profile = await this.bitbucketRequest<BitbucketUser>(tokens.accessToken, "https://api.bitbucket.org/2.0/user");
      return this.saveConnection(oauthState, provider, profile.account_id, profile.username, tokens);
    }
    const tokens = await this.exchangeGitlab(code);
    const profile = await this.gitlabRequest<GitlabUser>(tokens.accessToken, "https://gitlab.com/api/v4/user");
    return this.saveConnection(oauthState, provider, String(profile.id), profile.username, tokens);
  }

  async listRepositories(user: AuthenticatedUser, provider: ProviderName) {
    const accessToken = await this.providerToken(user.organizationId, provider);
    if (provider === "GITHUB") {
      const repositories = await this.githubRequest<GithubRepository[]>(accessToken, "https://api.github.com/user/repos?per_page=100&sort=updated");
      return repositories.map((repository) => ({ externalId: String(repository.id), fullName: repository.full_name, private: repository.private, defaultBranch: repository.default_branch, url: repository.html_url }));
    }
    if (provider === "BITBUCKET") {
      const page = await this.bitbucketRequest<BitbucketRepositories>(accessToken, "https://api.bitbucket.org/2.0/repositories?role=contributor&pagelen=100");
      return page.values.map((repository) => ({ externalId: repository.uuid, fullName: repository.full_name, private: repository.is_private, defaultBranch: repository.mainbranch?.name ?? "master", url: repository.links.html.href }));
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

  /** Preferred token lookup: exact provider connection, newest first. Returns a
   *  valid access token, transparently refreshing expired ones when possible. */
  async providerToken(organizationId: string, provider: ProviderName) {
    const connection = await this.prisma.repositoryConnection.findFirst({ where: { organizationId, provider }, orderBy: { updatedAt: "desc" } });
    if (!connection) throw new NotFoundException(`No ${provider.toLowerCase()} account is connected to this organization`);
    const accessToken = this.decryptAccess(connection);
    // GitHub OAuth app tokens do not expire. Bitbucket/GitLab access tokens live
    // ~1 hour; refresh them shortly before expiry using the stored refresh token.
    if (provider === "GITHUB" || !connection.accessTokenExpiresAt || connection.accessTokenExpiresAt.getTime() > Date.now() + TOKEN_EXPIRY_SKEW_MS) return accessToken;
    const refreshToken = this.decryptRefresh(connection);
    if (!refreshToken) return accessToken; // Connection predates refresh-token storage — the API call will 401 and ask for a reconnect.
    return this.refreshAccessToken(connection, refreshToken);
  }

  private async refreshAccessToken(connection: { id: string; provider: ProviderName }, refreshToken: string) {
    const label = connection.provider === "BITBUCKET" ? "Bitbucket" : connection.provider === "GITLAB" ? "GitLab" : "GitHub";
    try {
      const tokens = connection.provider === "BITBUCKET" ? await this.refreshBitbucket(refreshToken) : await this.refreshGitlab(refreshToken);
      await this.prisma.repositoryConnection.update({ where: { id: connection.id }, data: this.tokenData(tokens) });
      return tokens.accessToken;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new BadRequestException(`${label} access token expired and could not be refreshed (${reason}). Open Settings, disconnect the ${label} account, and connect it again.`);
    }
  }

  private async refreshBitbucket(refreshToken: string): Promise<ProviderTokens> {
    const clientId = this.requireConfig("BITBUCKET_CLIENT_ID", "BITBUCKET");
    const clientSecret = this.requireConfig("BITBUCKET_CLIENT_SECRET", "BITBUCKET");
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await fetch("https://bitbucket.org/site/oauth2/access_token", { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }) });
    return this.extractTokens(response, "Bitbucket");
  }

  private async refreshGitlab(refreshToken: string): Promise<ProviderTokens> {
    const clientId = this.requireConfig("GITLAB_CLIENT_ID", "GITLAB");
    const clientSecret = this.requireConfig("GITLAB_CLIENT_SECRET", "GITLAB");
    const response = await fetch("https://gitlab.com/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }) });
    return this.extractTokens(response, "GitLab");
  }

  private async saveConnection(oauthState: OAuthState, provider: ProviderName, externalAccountId: string, accountLogin: string, tokens: ProviderTokens) {
    await this.prisma.repositoryConnection.upsert({
      where: { organizationId_provider_externalAccountId: { organizationId: oauthState.organizationId, provider, externalAccountId } },
      create: { organizationId: oauthState.organizationId, provider, externalAccountId, accountLogin, ...this.tokenData(tokens) },
      update: { accountLogin, ...this.tokenData(tokens) }
    });
    await recordAudit(this.prisma, {
      organizationId: oauthState.organizationId, actorId: oauthState.userId, action: "repository.connected",
      targetType: "RepositoryConnection", metadata: { provider, account: accountLogin }
    });
    return { provider, account: accountLogin };
  }

  /** Encrypted column values for one token grant. Refresh-token columns are left
   *  untouched (undefined) when the grant did not include one. */
  private tokenData(tokens: ProviderTokens) {
    const access = this.encryptParts(tokens.accessToken);
    const refresh = tokens.refreshToken ? this.encryptParts(tokens.refreshToken) : undefined;
    return {
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenTag: access.tag,
      accessTokenExpiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
      refreshTokenCiphertext: refresh?.ciphertext,
      refreshTokenIv: refresh?.iv,
      refreshTokenTag: refresh?.tag
    };
  }

  private async exchangeGithub(code: string): Promise<ProviderTokens> {
    const clientId = this.requireConfig("GITHUB_CLIENT_ID", "GITHUB");
    const clientSecret = this.requireConfig("GITHUB_CLIENT_SECRET", "GITHUB");
    const response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }) });
    return this.extractTokens(response, "GitHub");
  }

  private async exchangeBitbucket(code: string): Promise<ProviderTokens> {
    const clientId = this.requireConfig("BITBUCKET_CLIENT_ID", "BITBUCKET");
    const clientSecret = this.requireConfig("BITBUCKET_CLIENT_SECRET", "BITBUCKET");
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.callbackUrl("BITBUCKET") });
    let response: Response;
    try {
      response = await fetch("https://bitbucket.org/site/oauth2/access_token", { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Bitbucket token exchange failed: ${msg}`);
    }
    return this.extractTokens(response, "Bitbucket");
  }

  private async exchangeGitlab(code: string): Promise<ProviderTokens> {
    const clientId = this.requireConfig("GITLAB_CLIENT_ID", "GITLAB");
    const clientSecret = this.requireConfig("GITLAB_CLIENT_SECRET", "GITLAB");
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: this.callbackUrl("GITLAB") });
    const response = await fetch("https://gitlab.com/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    return this.extractTokens(response, "GitLab");
  }

  private async extractTokens(response: Response, providerLabel: string): Promise<ProviderTokens> {
    const payload = await response.json() as TokenResponse;
    if (!response.ok || !payload.access_token) throw new BadRequestException(payload.error_description ?? `${providerLabel} did not grant an access token`);
    return { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresIn: payload.expires_in };
  }

  private requireConfig(key: string, provider: ProviderName) {
    const value = this.config.get<string>(key);
    const trimmed = value?.toString().trim();
    if (!trimmed) throw new BadRequestException(`${provider.charAt(0)}${provider.slice(1).toLowerCase()} OAuth is not configured on this deployment (missing ${key})`);
    return trimmed;
  }

  private callbackUrl(provider: ProviderName) {
    const envKey = provider === "GITHUB" ? "GITHUB_CALLBACK_URL" : provider === "BITBUCKET" ? "BITBUCKET_CALLBACK_URL" : "GITLAB_CALLBACK_URL";
    const value = this.config.get<string>(envKey);
    return value?.toString().trim() || `http://localhost:4000/v1/repository-connections/${provider.toLowerCase()}/callback`;
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

  private encryptParts(value: string) {
    const key = this.encryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  }

  private decryptAccess(connection: { accessTokenCiphertext: string; accessTokenIv: string; accessTokenTag: string }) {
    return this.decryptField(connection.accessTokenCiphertext, connection.accessTokenIv, connection.accessTokenTag);
  }

  private decryptRefresh(connection: { refreshTokenCiphertext: string | null; refreshTokenIv: string | null; refreshTokenTag: string | null }) {
    if (!connection.refreshTokenCiphertext || !connection.refreshTokenIv || !connection.refreshTokenTag) return null;
    return this.decryptField(connection.refreshTokenCiphertext, connection.refreshTokenIv, connection.refreshTokenTag);
  }

  private decryptField(ciphertext: string, iv: string, tag: string) {
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
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
