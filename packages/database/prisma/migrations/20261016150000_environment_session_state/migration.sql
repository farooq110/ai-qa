-- Saved Playwright storageState for session reuse across analysis/verify/execution.
ALTER TABLE "EnvironmentProfile" ADD COLUMN "sessionStateEnc" TEXT;
ALTER TABLE "EnvironmentProfile" ADD COLUMN "sessionStateIv" TEXT;
ALTER TABLE "EnvironmentProfile" ADD COLUMN "sessionStateTag" TEXT;
ALTER TABLE "EnvironmentProfile" ADD COLUMN "sessionSavedAt" TIMESTAMP(3);
