-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('CLIENT', 'ADMIN');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "StorageLifecycle" AS ENUM ('LINKED', 'REMOVED');

-- CreateTable
CREATE TABLE "Member" (
    "npub" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'CLIENT',
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "addedByNpub" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("npub")
);

-- CreateTable
CREATE TABLE "Storage" (
    "npub" TEXT NOT NULL,
    "ownerNpub" TEXT NOT NULL,
    "tunnelIp" TEXT,
    "blossomPort" INTEGER,
    "relayPort" INTEGER,
    "declaredCapacityBytes" BIGINT,
    "reportedTotalBytes" BIGINT,
    "reportedFreeBytes" BIGINT,
    "lifecycle" "StorageLifecycle" NOT NULL DEFAULT 'LINKED',
    "lastPingAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Storage_pkey" PRIMARY KEY ("npub")
);

-- CreateIndex
CREATE INDEX "Storage_lifecycle_lastPingAt_idx" ON "Storage"("lifecycle", "lastPingAt");

-- CreateIndex
CREATE INDEX "Storage_ownerNpub_idx" ON "Storage"("ownerNpub");

-- AddForeignKey
ALTER TABLE "Storage" ADD CONSTRAINT "Storage_ownerNpub_fkey" FOREIGN KEY ("ownerNpub") REFERENCES "Member"("npub") ON DELETE RESTRICT ON UPDATE CASCADE;
