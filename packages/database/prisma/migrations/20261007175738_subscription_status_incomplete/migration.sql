-- AlterEnum
-- Postgres cannot use a new enum value in the transaction that adds it, so this lives in its own migration;
-- the next one sets it as a column default.
ALTER TYPE "SubscriptionStatus" ADD VALUE 'INCOMPLETE';
