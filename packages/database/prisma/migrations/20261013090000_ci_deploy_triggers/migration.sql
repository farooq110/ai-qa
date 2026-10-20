-- DropForeignKey
ALTER TABLE "CiConnection" DROP CONSTRAINT "CiConnection_projectId_fkey";

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "ciBranchRules" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "ciEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ciEnvironmentFilter" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "ciHookId" TEXT,
ADD COLUMN     "ciHookSecretCiphertext" TEXT,
ADD COLUMN     "ciHookSecretIv" TEXT,
ADD COLUMN     "ciHookSecretTag" TEXT,
ADD COLUMN     "ciPullRequests" BOOLEAN NOT NULL DEFAULT false;

-- DropTable
DROP TABLE "CiConnection";

-- DropTable
DROP TABLE "CiExecutionRequest";

-- DropEnum
DROP TYPE "CiProviderName";

-- CreateTable
CREATE TABLE "CiRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "executionPlanId" TEXT,
    "provider" "RepositoryProvider" NOT NULL,
    "deliveryKey" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "pullRequest" INTEGER,
    "environmentName" TEXT NOT NULL DEFAULT '',
    "environmentUrl" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "reason" TEXT,
    "externalCheckId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CiRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CiRun_executionPlanId_key" ON "CiRun"("executionPlanId");

-- CreateIndex
CREATE INDEX "CiRun_projectId_branch_status_idx" ON "CiRun"("projectId", "branch", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CiRun_projectId_deliveryKey_key" ON "CiRun"("projectId", "deliveryKey");

-- AddForeignKey
ALTER TABLE "CiRun" ADD CONSTRAINT "CiRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CiRun" ADD CONSTRAINT "CiRun_executionPlanId_fkey" FOREIGN KEY ("executionPlanId") REFERENCES "ExecutionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

