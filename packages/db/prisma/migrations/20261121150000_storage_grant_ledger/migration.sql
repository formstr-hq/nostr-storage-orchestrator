-- Storage grant ledger — schema only.
--
-- This migration intentionally does NOT copy existing entitlements into the
-- new table. Data migrations in this repo are run manually (see
-- scripts/backfill-storage-grants.sql), so the operator controls the cutover:
--
--   1. apply this migration
--   2. run scripts/backfill-storage-grants.sql
--   3. deploy the code that reads grants
--
-- Until step 2 runs, an account has no grants and therefore derives as UNPAID.

CREATE TABLE "storage_grant" (
    "id" TEXT NOT NULL,
    "npub" TEXT NOT NULL,
    "plan_id" TEXT,
    "storage_bytes" BIGINT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "source_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_grant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "storage_grant_source_ref_key" ON "storage_grant"("source_ref");
CREATE INDEX "storage_grant_npub_starts_at_expires_at_idx" ON "storage_grant"("npub", "starts_at", "expires_at");
CREATE INDEX "storage_grant_npub_expires_at_idx" ON "storage_grant"("npub", "expires_at");

ALTER TABLE "storage_grant"
    ADD CONSTRAINT "storage_grant_npub_fkey"
    FOREIGN KEY ("npub") REFERENCES "user"("npub")
    ON DELETE CASCADE ON UPDATE CASCADE;
