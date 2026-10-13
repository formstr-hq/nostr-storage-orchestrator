-- Shared blobs: the primary key becomes (hash, npub) so identical content
-- uploaded by two accounts is billed to each owner. Existing rows keep their
-- single owner; nothing is dropped or rewritten.
ALTER TABLE "blob" DROP CONSTRAINT "blob_pkey";
ALTER TABLE "blob" ADD CONSTRAINT "blob_pkey" PRIMARY KEY ("hash", "npub");
CREATE INDEX "blob_hash_idx" ON "blob"("hash");
CREATE INDEX "blob_npub_idx" ON "blob"("npub");

-- Idempotency record for paid entitlement pushes (additive).
CREATE TABLE "entitlement_grant" (
    "payment_hash" TEXT NOT NULL,
    "npub" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "entitlement_grant_pkey" PRIMARY KEY ("payment_hash")
);
CREATE INDEX "entitlement_grant_npub_idx" ON "entitlement_grant"("npub");
