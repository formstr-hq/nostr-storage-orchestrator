-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'BASIC', 'PRO');

-- CreateTable
CREATE TABLE "Blob" (
    "hash" TEXT NOT NULL,
    "npub" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "replicas" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Blob_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "User" (
    "npub" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("npub")
);

-- AddForeignKey
ALTER TABLE "Blob" ADD CONSTRAINT "Blob_npub_fkey" FOREIGN KEY ("npub") REFERENCES "User"("npub") ON DELETE RESTRICT ON UPDATE CASCADE;
