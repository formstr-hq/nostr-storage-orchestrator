-- Manual, one-off backfill of the legacy single-entitlement rows into the
-- grant ledger. NOT part of a Prisma migration: data changes are run by an
-- operator, never automatically on deploy.
--
-- Recommended order:
--   1. apply the storage_grant_ledger migration
--   2. run this file
--   3. deploy the grant-reading code
--
-- Safe to re-run: source_ref is unique and the insert is ON CONFLICT DO NOTHING.
--
-- Run with, e.g.:
--   docker exec -i nso_postgres psql -U orchestrator -d orchestrator \
--     < scripts/backfill-storage-grants.sql

BEGIN;

INSERT INTO "storage_grant" (
    "id", "npub", "plan_id", "storage_bytes",
    "starts_at", "expires_at", "source", "source_ref", "created_at"
)
SELECT
    gen_random_uuid()::text,
    "npub",
    NULL,
    "storage_bytes",
    "created_at",
    "plan_expires_at",
    'legacy',
    'legacy:' || "npub",
    CURRENT_TIMESTAMP
FROM "user"
WHERE "storage_bytes" IS NOT NULL
  AND "plan_expires_at" IS NOT NULL
ON CONFLICT ("source_ref") DO NOTHING;

COMMIT;

-- Verification: every legacy entitlement should now have exactly one grant,
-- and the active sum should match the old storage_bytes for live plans.
SELECT
    u.npub,
    u.storage_bytes AS legacy_bytes,
    u.plan_expires_at,
    COALESCE(SUM(g.storage_bytes) FILTER (
        WHERE g.starts_at <= now() AND now() < g.expires_at
    ), 0) AS active_grant_bytes,
    count(g.id) AS grant_count
FROM "user" u
LEFT JOIN "storage_grant" g ON g.npub = u.npub
GROUP BY u.npub, u.storage_bytes, u.plan_expires_at
ORDER BY u.npub;
