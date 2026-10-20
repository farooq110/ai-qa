-- Phase 4: flow specs, analysis progress, and analysis-scoped AI usage.
ALTER TABLE "AnalysisRun" ADD COLUMN "progress" JSONB;
ALTER TABLE "AiUsageRecord" ADD COLUMN "analysisRunId" TEXT;

CREATE TABLE "FlowSpec" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sliceHash" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "files" JSONB NOT NULL,
    "stats" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlowSpec_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FlowSpec_projectId_moduleKey_sliceHash_key" ON "FlowSpec"("projectId", "moduleKey", "sliceHash");

ALTER TABLE "FlowSpec" ADD CONSTRAINT "FlowSpec_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
