import type { DbClient, UserInfo } from "@orchestrator/db-client";
import {
  deriveAccess,
  type AccessState,
  type LifecycleConfig,
  type UserStatus,
} from "@orchestrator/lifecycle";

export type { AccessState };
export { deriveAccess };

/**
 * Cached owner-access lookup. Access states change on day-scale boundaries,
 * so a short TTL keeps every read from hitting db-api while still applying a
 * new plan/expiry within seconds.
 */
export interface AccessCache {
  get(npub: string): Promise<UserInfo | null>;
  invalidate(npub: string): void;
}

export function createAccessCache(options: {
  db: DbClient;
  ttlMs: number;
}): AccessCache {
  const cache = new Map<string, { user: UserInfo | null; at: number }>();

  return {
    async get(npub: string) {
      const now = Date.now();
      const hit = cache.get(npub);
      if (hit && now - hit.at < options.ttlMs) {
        return hit.user;
      }
      const user = await options.db.getUser(npub);
      cache.set(npub, { user, at: now });
      return user;
    },
    invalidate(npub: string) {
      cache.delete(npub);
    },
  };
}

export interface DerivedUser {
  user: UserInfo;
  access: AccessState;
}

export function withAccess(user: UserInfo, config: LifecycleConfig, now = new Date()): DerivedUser {
  const access = deriveAccess(
    {
      planExpiresAt: user.planExpiresAt,
      storageBytes: user.storageBytes,
      usedStorage: user.usedStorage,
    },
    now,
    config,
  );

  // A purge is terminal until a new purchase: with no live plan the derived
  // state is already "closed" once the retention window elapses, and a
  // re-purchase writes a future expiry. No stored mirror is needed.

  return { user, access };
}

export const STATUS_ERROR_CODES: Record<UserStatus, string> = {
  UNPAID: "unpaid",
  ACTIVE: "active",
  GRACE: "grace",
  WRITE_BLOCKED: "write_blocked",
  READ_BLOCKED: "read_blocked",
  CLOSED: "account_closed",
};
