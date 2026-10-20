-- Phase 2: archive ingestion needs to know which extra top-level dirs hold backend code.
ALTER TABLE "Project" ADD COLUMN "backendDirectories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
