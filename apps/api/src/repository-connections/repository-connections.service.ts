import { createCipheriv, createDecipheriv, createHash, createSign, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { RepositoryConnection } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { recordAudit } from "../common/audit";
import { PermissionsService } from "../rbac/permissions.service";
import { PERMISSIONS } from "@ai-qa/domain";

export type ProviderName = "GITHUB" | "BITBUCKET" | "GITLAB";

const providerNames: ProviderName[] = ["GITHUB", "BITBUCKET", "GITLAB"];

/** Refresh this long before expiry so in-flight API calls never race the clock. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;
/** GitHub installations can expose thousands of repositories; stop paging here. */
const MAX_REPOSITORY_PAGES = 10;
/** Where the OAuth round trip may land the user afterwards. */
const RETURN_PATHS = ["/settings", "/projects"] as const;
type ReturnPath = (typeof RETURN_PATHS)[number];

interface OAuthState extends AuthenticatedUser { nonce: string; baseUrl: string; returnTo: ReturnPath }
interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
type ProviderTokens = { accessToken: string; refreshToken?: string; expiresIn?: number };
export interface RepositorySummary { externalId: string; fullName: string; private: boolean; defaultBranch: string; url: string }
export interface CallbackQuery { code?: string; state?: string; installation_id?: string; setup_action?: string }
interface GithubInstallation { id: number; account: { id: number; login: string } | null }
interface GithubRepository { id: number; full_name: string; private: boolean; default_branch: string; html_url: string }
interface GithubBranch { name: string; commit: { sha: string } }
interface BitbucketUser { account_id: string; username: string; display_name: string }
interface BitbucketRepository { uuid: string; full_name: string; is_private: boolean; mainbranch?: { name?: string }; links: { html: { href: string } } }
interface BitbucketBranches { values: Array<{ name: string; target: { hash: string } }> }
interface GitlabUser { id: number; username: string; name: string }
interface GitlabProject { id: number; path_with_namespace: string; visibility: string; default_branch: string | null; web_url: string }
interface GitlabBranch { name: string; commit: { id: string } }

@Injectable()
export class RepositoryConnectionsService {
  // ponytail: per-process cache of GitHub installation tokens (1h lifetime); move to Redis if API scales out and mint rate matters.
  private readonly installationTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService, private readonly jwt: JwtService, private readonly permissions: PermissionsService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.repositoryConnection.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, provider: true, baseUrl: true, accountLogin: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" }
    });
  }

  async disconnect(user: AuthenticatedUser, connectionId: string) {
    await this.permissions.assert(user, PERMISSIONS.SETTINGS_MANAGE);
    const connection = await this.prisma.repositoryConnection.findFirst({ where: { id: connectionId, organizationId: user.organizationId } });
    if (!connection) throw new NotFoundException("Connected account not found for this organization");
    await this.prisma.repositoryConnection.delete({ where: { id: connectionId } });
    if (connection.installationId) this.installationTokens.delete(connection.installationId);
    await recordAudit(this.prisma, {
      organizationId: user.organizationId, actorId: user.userId, action: "repository.disconnected",
      targetType: "RepositoryConnection", targetId: connectionId, metadata: { provider: connection.provider, account: connection.accountLogin }
    });
    return { disconnected: true, provider: connection.provider, account: connection.accountLogin };
  }

  /**
   * Where to send the browser to connect an account. GitHub: the platform GitHub App's install page
   * (the user picks an account and all/selected repositories). Bitbucket/GitLab.com: the platform
   * OAuth app. `selfManaged` GitLab uses the organization's own OAuth app on its own instance.
   */
  async authorizationUrl(user: AuthenticatedUser, provider: ProviderName, options: { selfManaged?: boolean; returnTo?: string } = {}) {
    const baseUrl = provider === "GITLAB" && options.selfManaged ? (await this.requireSelfManagedGitlab(user.organizationId)).baseUrl : "";
    const returnTo = RETURN_PATHS.find((path) => path === options.returnTo) ?? "/settings";
    const state = await this.jwt.signAsync({ ...user, nonce: randomBytes(16).toString("hex"), baseUrl, returnTo } satisfies OAuthState, { expiresIn: "10m" });
    if (provider === "GITHUB") {
      return { url: `https://github.com/apps/${encodeURIComponent(this.platformSetting("GITHUB_APP_SLUG", "GitHub"))}/installations/new?${new URLSearchParams({ state })}` };
    }
    const { clientId } = await this.clientCredentials(user.organizationId, provider, baseUrl);
    const redirectUri = this.callbackUrl(provider);
    if (provider === "BITBUCKET") {
      // Bitbucket scopes are fixed on the OAuth consumer itself: account, repository, pullrequest, webhook.
      return { url: `https://bitbucket.org/site/oauth2/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", state })}` };
    }
    // `api` (not read_api): CI needs to register webhooks and post commit statuses with this grant.
    return { url: `${gitlabHost(baseUrl)}/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", state, scope: "api" })}` };
  }

  /** Completes the provider round trip. Returns where to send the browser next. */
  async completeConnection(provider: ProviderName, query: CallbackQuery) {
    if (!query.state) throw new BadRequestException("Callback is missing state");
    const oauthState = await this.jwt.verifyAsync<OAuthState>(query.state);
    if (provider === "GITHUB") {
      // An org member without owner rights can only *request* the install; an owner approves it on GitHub later.
      if (query.setup_action === "request") return { returnTo: oauthState.returnTo, pending: true };
      if (!query.installation_id || !query.code) throw new BadRequestException("GitHub callback requires installation_id and code");
      const installation = await this.verifyGithubInstallation(query.code, query.installation_id);
      await this.saveConnection(oauthState, provider, String(installation.account.id), installation.account.login, { installationId: String(installation.id) });
      return { returnTo: oauthState.returnTo, pending: false };
    }
    if (!query.code) throw new BadRequestException("Callback requires code");
    const tokens = await this.exchangeCode(oauthState.organizationId, provider, oauthState.baseUrl, query.code);
    if (provider === "BITBUCKET") {
      const profile = await this.request<BitbucketUser>(provider, tokens.accessToken, "https://api.bitbucket.org/2.0/user");
      await this.saveConnection(oauthState, provider, profile.account_id, profile.username, this.tokenData(tokens));
    } else {
      const profile = await this.request<GitlabUser>(provider, tokens.accessToken, `${gitlabApi(oauthState.baseUrl)}/user`);
      await this.saveConnection(oauthState, provider, String(profile.id), profile.username, this.tokenData(tokens));
    }
    return { returnTo: oauthState.returnTo, pending: false };
  }

  /** Repositories the connection can import. GitHub lists exactly what the installation was granted. */
  async listRepositories(user: AuthenticatedUser, connectionId: string, search = ""): Promise<RepositorySummary[]> {
    await this.permissions.assert(user, PERMISSIONS.PROJECTS_CREATE);
    const connection = await this.requireConnection(user.organizationId, connectionId);
    const token = await this.connectionToken(connection);
    const term = search.trim();
    if (connection.provider === "GITHUB") {
      const repositories: GithubRepository[] = [];
      for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
        const batch = await this.request<{ repositories: GithubRepository[] }>("GITHUB", token, `https://api.github.com/installation/repositories?per_page=100&page=${page}`);
        repositories.push(...batch.repositories);
        if (batch.repositories.length < 100) break;
      }
      return repositories.filter((repository) => repository.full_name.toLowerCase().includes(term.toLowerCase())).map(githubSummary);
    }
    if (connection.provider === "BITBUCKET") {
      const query = new URLSearchParams({ role: "contributor", pagelen: "100", sort: "-updated_on", ...(term ? { q: `full_name ~ "${term.replace(/["\\]/g, "")}"` } : {}) });
      const page = await this.request<{ values: BitbucketRepository[] }>("BITBUCKET", token, `https://api.bitbucket.org/2.0/repositories?${query}`);
      return page.values.map(bitbucketSummary);
    }
    const query = new URLSearchParams({ membership: "true", per_page: "100", order_by: "last_activity_at", ...(term ? { search: term, search_namespaces: "true" } : {}) });
    const projects = await this.request<GitlabProject[]>("GITLAB", token, `${gitlabApi(connection.baseUrl)}/projects?${query}`);
    return projects.map(gitlabSummary);
  }

  async listBranches(user: AuthenticatedUser, connectionId: string, repository: string) {
    const connection = await this.requireConnection(user.organizationId, connectionId);
    assertRepositoryPath(connection.provider, repository);
    const token = await this.connectionToken(connection);
    if (connection.provider === "GITHUB") {
      const branches = await this.request<GithubBranch[]>("GITHUB", token, `https://api.github.com/repos/${repository}/branches?per_page=100`);
      return branches.map((branch) => ({ name: branch.name, commitSha: branch.commit.sha }));
    }
    if (connection.provider === "BITBUCKET") {
      const page = await this.request<BitbucketBranches>("BITBUCKET", token, `https://api.bitbucket.org/2.0/repositories/${repository}/refs/branches?pagelen=100`);
      return page.values.map((branch) => ({ name: branch.name, commitSha: branch.target.hash }));
    }
    const branches = await this.request<GitlabBranch[]>("GITLAB", token, `${gitlabApi(connection.baseUrl)}/projects/${encodeURIComponent(repository)}/repository/branches?per_page=100`);
    return branches.map((branch) => ({ name: branch.name, commitSha: branch.commit.id }));
  }

  /** Authoritative repository metadata for an import — never trust the client's copy. */
  async getRepository(organizationId: string, connectionId: string, repository: string): Promise<{ connection: RepositoryConnection; repository: RepositorySummary }> {
    const connection = await this.requireConnection(organizationId, connectionId);
    assertRepositoryPath(connection.provider, repository);
    const token = await this.connectionToken(connection);
    if (connection.provider === "GITHUB") return { connection, repository: githubSummary(await this.request<GithubRepository>("GITHUB", token, `https://api.github.com/repos/${repository}`)) };
    if (connection.provider === "BITBUCKET") return { connection, repository: bitbucketSummary(await this.request<BitbucketRepository>("BITBUCKET", token, `https://api.bitbucket.org/2.0/repositories/${repository}`)) };
    return { connection, repository: gitlabSummary(await this.request<GitlabProject>("GITLAB", token, `${gitlabApi(connection.baseUrl)}/projects/${encodeURIComponent(repository)}`)) };
  }

  /**
   * Token + API host for a project. Imported projects use their own connection; projects created
   * before repository import fall back to the organization's newest connection for the provider.
   */
  async projectAccess(project: { organizationId: string; provider: ProviderName; repositoryConnectionId: string | null }) {
    const connection = project.repositoryConnectionId
      ? await this.prisma.repositoryConnection.findFirst({ where: { id: project.repositoryConnectionId, organizationId: project.organizationId } })
      : await this.prisma.repositoryConnection.findFirst({ where: { organizationId: project.organizationId, provider: project.provider }, orderBy: { updatedAt: "desc" } });
    if (!connection) throw new NotFoundException(`The ${providerLabel(project.provider)} account for this project is no longer connected. Reconnect it in Settings → Repository providers.`);
    return { token: await this.connectionToken(connection), gitlabApi: gitlabApi(connection.baseUrl) };
  }

  /** A valid API token for one connection: minted for GitHub installations, refreshed for OAuth grants. */
  private async connectionToken(connection: RepositoryConnection) {
    if (connection.installationId) return this.installationToken(connection.installationId, connection.accountLogin);
    const accessToken = this.decryptOptional(connection.accessTokenCiphertext, connection.accessTokenIv, connection.accessTokenTag);
    if (!accessToken) throw new BadRequestException(`${providerLabel(connection.provider)} connection ${connection.accountLogin} has no token. Disconnect it and connect again.`);
    // Legacy GitHub OAuth-app tokens do not expire. Bitbucket/GitLab access tokens live ~1 hour.
    if (!connection.accessTokenExpiresAt || connection.accessTokenExpiresAt.getTime() > Date.now() + TOKEN_EXPIRY_SKEW_MS) return accessToken;
    const refreshToken = this.decryptOptional(connection.refreshTokenCiphertext, connection.refreshTokenIv, connection.refreshTokenTag);
    if (!refreshToken) return accessToken; // Connection predates refresh-token storage — the API call will 401 and ask for a reconnect.
    return this.refreshAccessToken(connection, refreshToken);
  }

  private async installationToken(installationId: string, accountLogin: string) {
    const cached = this.installationTokens.get(installationId);
    if (cached && cached.expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS) return cached.token;
    const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { method: "POST", headers: { ...githubHeaders(this.githubAppJwt()) } });
    if (response.status === 404) throw new BadRequestException(`The GitHub App was uninstalled from ${accountLogin}. Disconnect it in Settings and connect GitHub again.`);
    if (!response.ok) throw new BadRequestException(`GitHub installation token request failed with status ${response.status}`);
    const payload = await response.json() as { token: string; expires_at: string };
    this.installationTokens.set(installationId, { token: payload.token, expiresAt: new Date(payload.expires_at).getTime() });
    return payload.token;
  }

  /**
   * Proves the browser that finished the install can see this installation. installation_id arrives
   * as a plain query parameter, so without this check anyone could claim another account's install.
   */
  private async verifyGithubInstallation(code: string, installationId: string) {
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.platformSetting("GITHUB_APP_CLIENT_ID", "GitHub"), client_secret: this.platformSetting("GITHUB_APP_CLIENT_SECRET", "GitHub"), code })
    });
    const { accessToken } = await this.extractTokens(response, "GitHub");
    for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
      const batch = await this.request<{ installations: GithubInstallation[] }>("GITHUB", accessToken, `https://api.github.com/user/installations?per_page=100&page=${page}`);
      const match = batch.installations.find((installation) => String(installation.id) === installationId);
      if (match?.account) return { id: match.id, account: match.account };
      if (batch.installations.length < 100) break;
    }
    throw new ForbiddenException("This GitHub installation is not accessible to the signed-in GitHub user");
  }

  /**
   * What GitHub will actually deliver for this installation: the events it is subscribed to and the
   * permissions the account has approved. A new permission or event on the app does nothing until the
   * installation accepts it, so the app's own settings page is not enough to prove CI will fire.
   */
  async githubInstallationInfo(project: { repositoryConnectionId: string | null; organizationId: string }) {
    const connection = project.repositoryConnectionId
      ? await this.prisma.repositoryConnection.findFirst({ where: { id: project.repositoryConnectionId, organizationId: project.organizationId } })
      : null;
    if (!connection?.installationId) return null;
    const headers = githubHeaders(this.githubAppJwt());
    const [installation, hook] = await Promise.all([
      fetch(`https://api.github.com/app/installations/${encodeURIComponent(connection.installationId)}`, { headers }),
      fetch("https://api.github.com/app/hook/config", { headers })
    ]);
    if (!installation.ok) throw new BadRequestException(`GitHub installation lookup failed with status ${installation.status}`);
    const info = await installation.json() as { events?: string[]; permissions?: Record<string, string> };
    const config = hook.ok ? await hook.json() as { url?: string } : {};
    return { events: info.events ?? [], permissions: info.permissions ?? {}, webhookUrl: config.url ?? "" };
  }

  /** RS256 app JWT (10 min max per GitHub; iat backdated for clock drift). */
  private githubAppJwt() {
    const appId = this.platformSetting("GITHUB_APP_ID", "GitHub");
    const privateKey = this.platformSetting("GITHUB_APP_PRIVATE_KEY", "GitHub").replace(/\\n/g, "\n");
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
  }

  private async refreshAccessToken(connection: RepositoryConnection, refreshToken: string) {
    const label = providerLabel(connection.provider);
    // Loaded before the try/catch on purpose: missing credentials must surface as their own message.
    const { clientId, clientSecret } = await this.clientCredentials(connection.organizationId, connection.provider, connection.baseUrl);
    try {
      const response = connection.provider === "BITBUCKET"
        ? await fetch("https://bitbucket.org/site/oauth2/access_token", { method: "POST", headers: { Authorization: basicAuth(clientId, clientSecret), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }) })
        : await fetch(`${gitlabHost(connection.baseUrl)}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken, redirect_uri: this.callbackUrl("GITLAB") }) });
      const tokens = await this.extractTokens(response, label);
      await this.prisma.repositoryConnection.update({ where: { id: connection.id }, data: this.tokenData(tokens) });
      return tokens.accessToken;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new BadRequestException(`${label} access token expired and could not be refreshed (${reason}). Open Settings, disconnect the ${label} account, and connect it again.`);
    }
  }

  private async exchangeCode(organizationId: string, provider: "BITBUCKET" | "GITLAB", baseUrl: string, code: string) {
    const { clientId, clientSecret } = await this.clientCredentials(organizationId, provider, baseUrl);
    const redirectUri = this.callbackUrl(provider);
    let response: Response;
    try {
      response = provider === "BITBUCKET"
        ? await fetch("https://bitbucket.org/site/oauth2/access_token", { method: "POST", headers: { Authorization: basicAuth(clientId, clientSecret), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }) })
        : await fetch(`${gitlabHost(baseUrl)}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }) });
    } catch (err) {
      throw new BadRequestException(`${providerLabel(provider)} token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.extractTokens(response, providerLabel(provider));
  }

  private async saveConnection(oauthState: OAuthState, provider: ProviderName, externalAccountId: string, accountLogin: string, credentials: Partial<RepositoryConnection>) {
    const baseUrl = oauthState.baseUrl;
    await this.prisma.repositoryConnection.upsert({
      where: { organizationId_provider_baseUrl_externalAccountId: { organizationId: oauthState.organizationId, provider, baseUrl, externalAccountId } },
      create: { organizationId: oauthState.organizationId, provider, baseUrl, externalAccountId, accountLogin, ...credentials },
      update: { accountLogin, ...credentials }
    });
    await recordAudit(this.prisma, {
      organizationId: oauthState.organizationId, actorId: oauthState.userId, action: "repository.connected",
      targetType: "RepositoryConnection", metadata: { provider, account: accountLogin, ...(baseUrl ? { baseUrl } : {}) }
    });
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

  private async extractTokens(response: Response, label: string): Promise<ProviderTokens> {
    const payload = await response.json() as TokenResponse;
    if (!response.ok || !payload.access_token) throw new BadRequestException(payload.error_description ?? `${label} did not grant an access token`);
    return { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresIn: payload.expires_in };
  }

  /** Self-managed GitLab OAuth app status. The secret never leaves the server. */
  async getSelfManagedGitlab(user: AuthenticatedUser) {
    const row = await this.prisma.integrationCredential.findUnique({ where: { organizationId_provider: { organizationId: user.organizationId, provider: "GITLAB" } }, select: { baseUrl: true, clientId: true } });
    return { baseUrl: row?.baseUrl ?? null, clientId: row?.clientId ?? null, redirectUri: this.callbackUrl("GITLAB") };
  }

  async saveSelfManagedGitlab(user: AuthenticatedUser, input: { baseUrl: string; clientId: string; clientSecret: string }) {
    if (user.role !== "ADMIN") throw new ForbiddenException("Only organization admins can manage OAuth app credentials");
    const baseUrl = normalizeInstanceUrl(input.baseUrl);
    const secret = this.encryptParts(input.clientSecret);
    const data = { baseUrl, clientId: input.clientId, clientSecretCiphertext: secret.ciphertext, clientSecretIv: secret.iv, clientSecretTag: secret.tag };
    await this.prisma.integrationCredential.upsert({
      where: { organizationId_provider: { organizationId: user.organizationId, provider: "GITLAB" } },
      create: { organizationId: user.organizationId, provider: "GITLAB", ...data },
      update: data
    });
    await recordAudit(this.prisma, {
      organizationId: user.organizationId, actorId: user.userId, action: "integration.credentials.saved",
      targetType: "IntegrationCredential", targetId: "GITLAB", metadata: { provider: "GITLAB", baseUrl, clientId: input.clientId }
    });
    return { baseUrl, clientId: input.clientId, redirectUri: this.callbackUrl("GITLAB") };
  }

  async removeSelfManagedGitlab(user: AuthenticatedUser) {
    if (user.role !== "ADMIN") throw new ForbiddenException("Only organization admins can manage OAuth app credentials");
    const existing = await this.prisma.integrationCredential.findUnique({ where: { organizationId_provider: { organizationId: user.organizationId, provider: "GITLAB" } } });
    if (!existing) throw new NotFoundException("No self-managed GitLab instance is configured for this organization");
    await this.prisma.integrationCredential.delete({ where: { id: existing.id } });
    await recordAudit(this.prisma, {
      organizationId: user.organizationId, actorId: user.userId, action: "integration.credentials.removed",
      targetType: "IntegrationCredential", targetId: "GITLAB", metadata: { provider: "GITLAB", baseUrl: existing.baseUrl, clientId: existing.clientId }
    });
    return { removed: true };
  }

  private async requireSelfManagedGitlab(organizationId: string) {
    const credential = await this.prisma.integrationCredential.findUnique({ where: { organizationId_provider: { organizationId, provider: "GITLAB" } } });
    if (!credential?.baseUrl) throw new BadRequestException("No self-managed GitLab instance is configured. An organization admin must add its URL and OAuth app in Settings → Repository providers.");
    return credential;
  }

  /** Platform OAuth app for SaaS hosts; the organization's own app for a self-managed GitLab instance. */
  private async clientCredentials(organizationId: string, provider: ProviderName, baseUrl: string) {
    if (baseUrl) {
      const credential = await this.requireSelfManagedGitlab(organizationId);
      if (credential.baseUrl !== baseUrl) throw new BadRequestException(`This organization's self-managed GitLab app now points at ${credential.baseUrl}. Disconnect ${baseUrl} and connect again.`);
      return { clientId: credential.clientId, clientSecret: this.decryptField(credential.clientSecretCiphertext, credential.clientSecretIv, credential.clientSecretTag) };
    }
    const label = providerLabel(provider);
    return { clientId: this.platformSetting(`${provider}_CLIENT_ID`, label), clientSecret: this.platformSetting(`${provider}_CLIENT_SECRET`, label) };
  }

  private platformSetting(key: string, label: string) {
    const value = this.config.get<string>(key)?.trim();
    if (!value) throw new BadRequestException(`${label} connections are not configured on this server (${key} is missing).`);
    return value;
  }

  private async requireConnection(organizationId: string, connectionId: string) {
    const connection = await this.prisma.repositoryConnection.findFirst({ where: { id: connectionId, organizationId } });
    if (!connection) throw new NotFoundException("Connected account not found for this organization");
    return connection;
  }

  callbackUrl(provider: ProviderName) {
    const value = this.config.get<string>(`${provider}_CALLBACK_URL`);
    return value?.toString().trim() || `http://localhost:4000/v1/repository-connections/${provider.toLowerCase()}/callback`;
  }

  private async request<T>(provider: ProviderName, token: string, url: string) {
    const response = await fetch(url, { headers: provider === "GITHUB" ? githubHeaders(token) : { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!response.ok) throw new BadRequestException(`${providerLabel(provider)} API request failed with status ${response.status}`);
    return response.json() as Promise<T>;
  }

  private encryptParts(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  }

  private decryptOptional(ciphertext: string | null, iv: string | null, tag: string | null) {
    return ciphertext && iv && tag ? this.decryptField(ciphertext, iv, tag) : null;
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

export function providerLabel(provider: ProviderName) {
  return provider === "BITBUCKET" ? "Bitbucket" : provider === "GITLAB" ? "GitLab" : "GitHub";
}

export function githubHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "proofline" };
}

const gitlabHost = (baseUrl: string) => baseUrl || "https://gitlab.com";
export const gitlabApi = (baseUrl: string) => `${gitlabHost(baseUrl)}/api/v4`;
const basicAuth = (clientId: string, clientSecret: string) => `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

/** owner/repo (GitHub, Bitbucket) or group/sub/project (GitLab). Rejects `.`/`..` segments so the
 *  value cannot walk the request onto a different API endpoint. */
export function assertRepositoryPath(provider: ProviderName, repository: string) {
  const segments = repository.split("/");
  const valid = segments.every((segment) => /^[\w.-]+$/.test(segment) && segment !== "." && segment !== "..")
    && (provider === "GITLAB" ? segments.length >= 2 : segments.length === 2);
  if (!valid) throw new BadRequestException(provider === "GITLAB" ? "repository must be a group/project path" : "repository must be in owner/name format");
}

/**
 * The server calls this URL with the organization's tokens, so it must be a public https origin.
 * ponytail: literal-host check only; a public hostname resolving to a private IP (DNS rebinding) still passes — resolve and pin the IP if self-managed GitLab is opened beyond trusted admins.
 */
export function normalizeInstanceUrl(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new BadRequestException("GitLab URL must be a valid URL, e.g. https://gitlab.example.com"); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const privateHost = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")
    || (isIP(host) !== 0 && /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80)/i.test(host));
  if (url.protocol !== "https:" || url.username || url.password || privateHost) throw new BadRequestException("GitLab URL must be a public https:// address");
  if (url.hostname === "gitlab.com") throw new BadRequestException("gitlab.com is connected directly — use Connect GitLab instead");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

const githubSummary = (repository: GithubRepository): RepositorySummary => ({ externalId: String(repository.id), fullName: repository.full_name, private: repository.private, defaultBranch: repository.default_branch, url: repository.html_url });
const bitbucketSummary = (repository: BitbucketRepository): RepositorySummary => ({ externalId: repository.uuid, fullName: repository.full_name, private: repository.is_private, defaultBranch: repository.mainbranch?.name ?? "master", url: repository.links.html.href });
const gitlabSummary = (project: GitlabProject): RepositorySummary => ({ externalId: String(project.id), fullName: project.path_with_namespace, private: project.visibility !== "public", defaultBranch: project.default_branch ?? "main", url: project.web_url });
