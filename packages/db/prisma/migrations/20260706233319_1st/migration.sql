-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'BASIC', 'PRO');

-- CreateTable
CREATE TABLE "Blob" (
    "hash" TEXT NOT NULL,
    "npub" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "replicas" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Blob_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "RelayEvent" (
    "eventId" TEXT NOT NULL,
    "npub" TEXT NOT NULL,
    "kind" INTEGER NOT NULL,
    "size" BIGINT NOT NULL,
    "replicas" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RelayEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "User" (
    "npub" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "usedStorage" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("npub")
);

-- CreateIndex
CREATE INDEX "RelayEvent_npub_idx" ON "RelayEvent"("npub");

-- CreateIndex
CREATE INDEX "RelayEvent_kind_idx" ON "RelayEvent"("kind");

-- CreateIndex
CREATE INDEX "RelayEvent_npub_kind_idx" ON "RelayEvent"("npub", "kind");

-- AddForeignKey
ALTER TABLE "Blob" ADD CONSTRAINT "Blob_npub_fkey" FOREIGN KEY ("npub") REFERENCES "User"("npub") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelayEvent" ADD CONSTRAINT "RelayEvent_npub_fkey" FOREIGN KEY ("npub") REFERENCES "User"("npub") ON DELETE RESTRICT ON UPDATE CASCADE;
