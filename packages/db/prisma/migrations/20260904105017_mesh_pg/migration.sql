-- AlterTable
ALTER TABLE "Storage" ADD COLUMN     "pgAgentPort" INTEGER;

-- CreateTable
CREATE TABLE "pg_table" (
    "name" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "replicaN" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pg_table_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "pg_migration" (
    "id" TEXT NOT NULL,
    "ddl" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "pg_migration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pg_migration_state" (
    "storage_npub" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pg_migration_state_pkey" PRIMARY KEY ("storage_npub","version")
);

-- CreateTable
CREATE TABLE "pg_write_op" (
    "id" TEXT NOT NULL,
    "table_name" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "row_id" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "last_attempt_at" TIMESTAMP(3),

    CONSTRAINT "pg_write_op_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pg_placement" (
    "table_name" TEXT NOT NULL,
    "row_id" TEXT NOT NULL,
    "replicas" TEXT[],
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pg_placement_pkey" PRIMARY KEY ("table_name","row_id")
);

-- CreateIndex
CREATE INDEX "pg_migration_state_version_idx" ON "pg_migration"("state", "version");

-- CreateIndex
CREATE INDEX "pg_write_op_table_name_row_id_idx" ON "pg_write_op"("table_name", "row_id");

-- CreateIndex
CREATE INDEX "pg_write_op_createdAt_idx" ON "pg_write_op"("createdAt");
