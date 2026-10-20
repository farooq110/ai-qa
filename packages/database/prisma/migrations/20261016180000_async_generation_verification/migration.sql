-- Async generation + dry-run verification (Phase 1).
ALTER TYPE "TestStatus" ADD VALUE 'DRAFT';
ALTER TABLE "TestCase" ADD COLUMN "generationRunId" TEXT;
ALTER TABLE "TestCase" ADD COLUMN "verification" JSONB;
ALTER TABLE "GenerationRun" ADD COLUMN "report" JSONB;
