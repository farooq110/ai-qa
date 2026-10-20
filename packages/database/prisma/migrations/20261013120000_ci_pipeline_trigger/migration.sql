-- CreateEnum
CREATE TYPE "CiTriggerMode" AS ENUM ('DEPLOYMENT', 'PIPELINE');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "ciTriggerMode" "CiTriggerMode" NOT NULL DEFAULT 'DEPLOYMENT',
ADD COLUMN     "ciWorkflowName" TEXT NOT NULL DEFAULT '';

