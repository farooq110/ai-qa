-- Store OAuth refresh tokens (encrypted) and access-token expiry so the API
-- can transparently refresh expired provider tokens (Bitbucket/GitLab).
ALTER TABLE "RepositoryConnection" ADD COLUMN "refreshTokenCiphertext" TEXT;
ALTER TABLE "RepositoryConnection" ADD COLUMN "refreshTokenIv" TEXT;
ALTER TABLE "RepositoryConnection" ADD COLUMN "refreshTokenTag" TEXT;
ALTER TABLE "RepositoryConnection" ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3);
