-- Phase 5: planner-assigned scenario key, deduped per project. NULL (legacy/non-planner tests)
-- is unconstrained - Postgres unique indexes allow multiple NULLs.
ALTER TABLE "TestCase" ADD COLUMN "scenarioKey" TEXT;
CREATE UNIQUE INDEX "TestCase_projectId_scenarioKey_key" ON "TestCase"("projectId", "scenarioKey");
