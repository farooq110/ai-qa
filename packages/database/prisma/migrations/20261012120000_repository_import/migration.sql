-- RepositoryConnection: GitHub App installations carry no stored token; self-managed GitLab gets a base URL.
ALTER TABLE "RepositoryConnection" ADD COLUMN "baseUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE "RepositoryConnection" ADD COLUMN "installationId" TEXT;
ALTER TABLE "RepositoryConnection" ALTER COLUMN "accessTokenCiphertext" DROP NOT NULL;
ALTER TABLE "RepositoryConnection" ALTER COLUMN "accessTokenIv" DROP NOT NULL;
ALTER TABLE "RepositoryConnection" ALTER COLUMN "accessTokenTag" DROP NOT NULL;
DROP INDEX "RepositoryConnection_organizationId_provider_externalAccoun_key";
CREATE UNIQUE INDEX "RepositoryConnection_organizationId_provider_baseUrl_extern_key" ON "RepositoryConnection"("organizationId", "provider", "baseUrl", "externalAccountId");

-- IntegrationCredential: self-managed GitLab instance URL.
ALTER TABLE "IntegrationCredential" ADD COLUMN "baseUrl" TEXT NOT NULL DEFAULT '';

-- Project: imported repository identity. Existing rows are backfilled from repositoryUrl and stay
-- unlinked (repositoryConnectionId NULL); analysis falls back to the org's newest connection for them.
ALTER TABLE "Project" ADD COLUMN "provider" "RepositoryProvider";
ALTER TABLE "Project" ADD COLUMN "repositoryConnectionId" TEXT;
ALTER TABLE "Project" ADD COLUMN "externalRepoId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Project" ADD COLUMN "repoFullName" TEXT;
ALTER TABLE "Project" ADD COLUMN "rootDirectory" TEXT NOT NULL DEFAULT '';

UPDATE "Project" SET "provider" = CASE
  WHEN "repositoryUrl" ~* 'bitbucket\.org' THEN 'BITBUCKET'::"RepositoryProvider"
  WHEN "repositoryUrl" ~* 'gitlab\.' THEN 'GITLAB'::"RepositoryProvider"
  ELSE 'GITHUB'::"RepositoryProvider"
END;
UPDATE "Project" SET "repoFullName" = regexp_replace(regexp_replace(regexp_replace(trim("repositoryUrl"), '/+$', ''), '\.git$', ''), '^(https?://|git@)[^/:]+[/:]', '');

ALTER TABLE "Project" ALTER COLUMN "provider" SET NOT NULL;
ALTER TABLE "Project" ALTER COLUMN "repoFullName" SET NOT NULL;
ALTER TABLE "Project" ADD CONSTRAINT "Project_repositoryConnectionId_fkey" FOREIGN KEY ("repositoryConnectionId") REFERENCES "RepositoryConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
