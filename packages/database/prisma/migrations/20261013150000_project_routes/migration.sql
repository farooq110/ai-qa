CREATE TYPE "RouteStatus" AS ENUM ('DISCOVERED', 'VERIFIED', 'UNREACHABLE');

CREATE TABLE "ProjectRoute" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "label" TEXT,
    "navOrder" INTEGER,
    "sources" TEXT[],
    "status" "RouteStatus" NOT NULL DEFAULT 'DISCOVERED',
    "reason" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "requiresAuth" BOOLEAN,
    "params" JSONB,
    "pageFile" TEXT,
    "inventory" JSONB,
    "apiCalls" TEXT[],
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectRoute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectRoute_projectId_pattern_key" ON "ProjectRoute"("projectId", "pattern");

ALTER TABLE "ProjectRoute" ADD CONSTRAINT "ProjectRoute_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
