-- One result per parameter set for tests run once per set (route parameter lists).
ALTER TABLE "ExecutionPlanItem" ADD COLUMN "variants" JSONB;
