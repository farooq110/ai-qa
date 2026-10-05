export type RepositoryProviderName = "github" | "bitbucket";

export interface ConnectedRepository {
  provider: RepositoryProviderName;
  externalId: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface RepositoryRevision {
  branch: string;
  commitSha: string;
  committedAt?: string;
}

export interface RepositoryProvider {
  readonly name: RepositoryProviderName;
  listRepositories(accessToken: string): Promise<ConnectedRepository[]>;
  listBranches(accessToken: string, repository: ConnectedRepository): Promise<string[]>;
  resolveRevision(accessToken: string, repository: ConnectedRepository, branchOrSha: string): Promise<RepositoryRevision>;
  compareRevisions(accessToken: string, repository: ConnectedRepository, baseCommit: string, targetCommit: string): Promise<{ changedFiles: string[]; }>;
}

export abstract class HttpRepositoryProvider implements RepositoryProvider {
  abstract readonly name: RepositoryProviderName;
  abstract listRepositories(accessToken: string): Promise<ConnectedRepository[]>;
  abstract listBranches(accessToken: string, repository: ConnectedRepository): Promise<string[]>;
  abstract resolveRevision(accessToken: string, repository: ConnectedRepository, branchOrSha: string): Promise<RepositoryRevision>;
  abstract compareRevisions(accessToken: string, repository: ConnectedRepository, baseCommit: string, targetCommit: string): Promise<{ changedFiles: string[]; }>;
}