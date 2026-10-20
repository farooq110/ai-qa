-- Phase 3: cached LLM output keyed by a hash of its own inputs, so a repeat analysis with nothing
-- changed makes 0 LLM calls.
CREATE TABLE "LlmCache" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LlmCache_projectId_kind_key_key" ON "LlmCache"("projectId", "kind", "key");

ALTER TABLE "LlmCache" ADD CONSTRAINT "LlmCache_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
