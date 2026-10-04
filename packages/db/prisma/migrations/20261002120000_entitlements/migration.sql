-- Entitlements: replace the legacy Plan enum on "User" with a nullable text
-- plan id, add entitlement/lifecycle/compliance columns, and create the
-- notification dedupe + moderation audit tables. Additive apart from the
-- enum-to-text conversion, which is data-preserving and maps the legacy FREE
-- tier to NULL (there is no free tier in the new service).

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('UNPAID', 'ACTIVE', 'GRACE', 'WRITE_BLOCKED', 'READ_BLOCKED', 'CLOSED');

-- AlterTable: convert legacy enum plan to nullable text; FREE becomes NULL.
ALTER TABLE "User" DROP COLUMN "plan";
ALTER TABLE "User" ADD COLUMN "plan" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "planExpiresAt" TIMESTAMP(3),
ADD COLUMN     "storageBytes" BIGINT,
ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'UNPAID',
ADD COLUMN     "statusChangedAt" TIMESTAMP(3),
ADD COLUMN     "termsVersion" TEXT,
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "npub" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT,
    "channel" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationAction" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "npub" TEXT NOT NULL,
    "adminNpub" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE INDEX "User_planExpiresAt_idx" ON "User"("planExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationLog_npub_kind_ref_channel_key" ON "NotificationLog"("npub", "kind", "ref", "channel");

-- CreateIndex
CREATE INDEX "NotificationLog_npub_sentAt_idx" ON "NotificationLog"("npub", "sentAt");

-- CreateIndex
CREATE INDEX "ModerationAction_hash_idx" ON "ModerationAction"("hash");

-- CreateIndex
CREATE INDEX "ModerationAction_npub_idx" ON "ModerationAction"("npub");
