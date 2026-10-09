-- CreateEnum
CREATE TYPE "mesh_role" AS ENUM ('CLIENT', 'ADMIN');

-- CreateEnum
CREATE TYPE "mesh_status" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "storage_lifecycle" AS ENUM ('LINKED', 'REMOVED');

-- DropForeignKey
ALTER TABLE "Blob" DROP CONSTRAINT "Blob_npub_fkey";

-- DropForeignKey
ALTER TABLE "Storage" DROP CONSTRAINT "Storage_ownerNpub_fkey";

-- DropTable
DROP TABLE "Blob";

-- DropTable
DROP TABLE "User";

-- DropTable
DROP TABLE "Member";

-- DropTable
DROP TABLE "Storage";

-- DropEnum
DROP TYPE "Plan";

-- DropEnum
DROP TYPE "MemberRole";

-- DropEnum
DROP TYPE "MemberStatus";

-- DropEnum
DROP TYPE "StorageLifecycle";

-- CreateTable
CREATE TABLE "user" (
    "npub" TEXT NOT NULL,
    "plan_expires_at" TIMESTAMP(3),
    "storage_bytes" BIGINT,
    "used_storage" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_pkey" PRIMARY KEY ("npub")
);

-- CreateTable
CREATE TABLE "blob" (
    "hash" TEXT NOT NULL,
    "npub" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "replicas" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blob_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "service_account" (
    "npub" TEXT NOT NULL,
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_account_pkey" PRIMARY KEY ("npub")
);

-- CreateTable
CREATE TABLE "notification_log" (
    "id" TEXT NOT NULL,
    "npub" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT,
    "channel" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_action" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "npub" TEXT NOT NULL,
    "admin_npub" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mesh_member" (
    "npub" TEXT NOT NULL,
    "mesh_role" "mesh_role" NOT NULL DEFAULT 'CLIENT',
    "status" "mesh_status" NOT NULL DEFAULT 'ACTIVE',
    "added_by_npub" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mesh_member_pkey" PRIMARY KEY ("npub")
);

-- CreateTable
CREATE TABLE "storage_provider" (
    "npub" TEXT NOT NULL,
    "owner_npub" TEXT NOT NULL,
    "tunnel_ip" TEXT,
    "blossom_port" INTEGER,
    "pg_agent_port" INTEGER,
    "declared_capacity_bytes" BIGINT,
    "reported_total_bytes" BIGINT,
    "reported_free_bytes" BIGINT,
    "lifecycle" "storage_lifecycle" NOT NULL DEFAULT 'LINKED',
    "last_ping_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_provider_pkey" PRIMARY KEY ("npub")
);

-- CreateIndex
CREATE INDEX "user_plan_expires_at_idx" ON "user"("plan_expires_at");

-- CreateIndex
CREATE INDEX "notification_log_npub_sent_at_idx" ON "notification_log"("npub", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_log_npub_kind_ref_channel_key" ON "notification_log"("npub", "kind", "ref", "channel");

-- CreateIndex
CREATE INDEX "moderation_action_hash_idx" ON "moderation_action"("hash");

-- CreateIndex
CREATE INDEX "moderation_action_npub_idx" ON "moderation_action"("npub");

-- CreateIndex
CREATE INDEX "storage_provider_lifecycle_last_ping_at_idx" ON "storage_provider"("lifecycle", "last_ping_at");

-- CreateIndex
CREATE INDEX "storage_provider_owner_npub_idx" ON "storage_provider"("owner_npub");

-- AddForeignKey
ALTER TABLE "blob" ADD CONSTRAINT "blob_npub_fkey" FOREIGN KEY ("npub") REFERENCES "user"("npub") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_provider" ADD CONSTRAINT "storage_provider_owner_npub_fkey" FOREIGN KEY ("owner_npub") REFERENCES "mesh_member"("npub") ON DELETE RESTRICT ON UPDATE CASCADE;

