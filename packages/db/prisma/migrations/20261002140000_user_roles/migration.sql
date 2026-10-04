-- Internal service identities: add a role to "User" so NIP-98 callers can be
-- gated by their registered npub instead of a shared bearer token.
--
-- "user" (default) is a blob owner; "service" and "admin" may call the
-- internal entitlement/admin endpoints. Existing rows keep working as owners.
ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user';

CREATE INDEX "User_role_idx" ON "User"("role");
