export type UserStatus =
  | "UNPAID"
  | "ACTIVE"
  | "GRACE"
  | "WRITE_BLOCKED"
  | "READ_BLOCKED"
  | "CLOSED";

export interface LifecycleNotifyConfig {
  expiryWarningDays: number[];
  quotaWarningPercent: number[];
}

export interface LifecycleConfig {
  graceDays: number;
  writeBlockedDays: number;
  readBlockedDays: number;
  purgeEnabled: boolean;
  notify: LifecycleNotifyConfig;
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  graceDays: 7,
  writeBlockedDays: 30,
  readBlockedDays: 30,
  purgeEnabled: false,
  notify: {
    expiryWarningDays: [14, 3, 1],
    quotaWarningPercent: [80, 100],
  },
};

function positiveInt(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`lifecycle config: ${name} must be a non-negative integer`);
  }
  return value;
}

function positiveIntArray(value: unknown, name: string, fallback: number[]): number[] {
  if (value === undefined || value === null) return fallback;
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "number" || !Number.isInteger(v) || v < 0)
  ) {
    throw new Error(`lifecycle config: ${name} must be an array of non-negative integers`);
  }
  return [...(value as number[])].sort((a, b) => b - a);
}

/**
 * Validates and normalises a parsed lifecycle config. Fail-fast: any
 * malformed field throws, so a bad mount stops the service at boot rather
 * than silently changing enforcement or retention.
 */
export function parseLifecycleConfig(raw: unknown): LifecycleConfig {
  if (raw === undefined || raw === null) {
    return DEFAULT_LIFECYCLE_CONFIG;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("lifecycle config: root must be a mapping");
  }
  const r = raw as Record<string, unknown>;
  const graceDays = positiveInt(r["graceDays"], "graceDays", DEFAULT_LIFECYCLE_CONFIG.graceDays);
  if (graceDays <= 0) {
    throw new Error("lifecycle config: graceDays must be positive");
  }
  const writeBlockedDays = positiveInt(
    r["writeBlockedDays"],
    "writeBlockedDays",
    DEFAULT_LIFECYCLE_CONFIG.writeBlockedDays,
  );
  const readBlockedDays = positiveInt(
    r["readBlockedDays"],
    "readBlockedDays",
    DEFAULT_LIFECYCLE_CONFIG.readBlockedDays,
  );
  if (typeof r["purgeEnabled"] !== "boolean" && r["purgeEnabled"] !== undefined) {
    throw new Error("lifecycle config: purgeEnabled must be a boolean");
  }
  const purgeEnabled =
    typeof r["purgeEnabled"] === "boolean"
      ? r["purgeEnabled"]
      : DEFAULT_LIFECYCLE_CONFIG.purgeEnabled;

  const rawNotify =
    typeof r["notify"] === "object" && r["notify"] !== null
      ? (r["notify"] as Record<string, unknown>)
      : undefined;

  const expiryWarningDays = positiveIntArray(
    rawNotify?.["expiryWarningDays"],
    "notify.expiryWarningDays",
    DEFAULT_LIFECYCLE_CONFIG.notify.expiryWarningDays,
  );
  const quotaWarningPercent = positiveIntArray(
    rawNotify?.["quotaWarningPercent"],
    "notify.quotaWarningPercent",
    DEFAULT_LIFECYCLE_CONFIG.notify.quotaWarningPercent,
  ).filter((p) => p <= 100);

  return {
    graceDays,
    writeBlockedDays,
    readBlockedDays,
    purgeEnabled,
    notify: { expiryWarningDays, quotaWarningPercent },
  };
}

export interface EntitlementDates {
  planExpiresAt: Date | string | null;
  usedStorage: bigint | number | string;
}

export interface AccessState {
  status: UserStatus;
  canUpload: boolean;
  canRead: boolean;
  canDelete: boolean;
  graceUntil: Date | null;
  writeBlockedUntil: Date | null;
  readBlockedUntil: Date | null;
  purgeAt: Date | null;
  reason:
    | "unpaid"
    | "active"
    | "grace_expired_plan"
    | "grace_over_quota"
    | "write_blocked"
    | "read_blocked"
    | "closed";
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Time-only derivation of a user's access state. This is the single
 * enforcement source in the proxy; `User.status` is only a mirror written by
 * the notifier for dashboards/audit, so enforcement never lags if the
 * notifier is down.
 *
 * Over-quota is derived from `usedStorage > storageBytes` rather than stored
 * separately: an over-quota user returns to ACTIVE as soon as they delete
 * blobs (usedStorage drops), and no state write is required for that.
 */
export function deriveAccess(
  user: EntitlementDates & { storageBytes: bigint | number | string | null },
  now: Date,
  config: LifecycleConfig,
): AccessState {
  const planExpiresAt = toDate(user.planExpiresAt);
  const used = BigInt(user.usedStorage);
  const allowance = user.storageBytes === null ? null : BigInt(user.storageBytes);

  if (planExpiresAt === null) {
    return {
      status: "UNPAID",
      canUpload: false,
      canRead: false,
      canDelete: false,
      graceUntil: null,
      writeBlockedUntil: null,
      readBlockedUntil: null,
      purgeAt: null,
      reason: "unpaid",
    };
  }

  const expiry = planExpiresAt.getTime();
  const graceUntil = new Date(expiry + config.graceDays * DAY_MS);
  const writeBlockedUntil = new Date(graceUntil.getTime() + config.writeBlockedDays * DAY_MS);
  const readBlockedUntil = new Date(
    writeBlockedUntil.getTime() + config.readBlockedDays * DAY_MS,
  );
  const closed = now.getTime() >= readBlockedUntil.getTime();

  if (closed) {
    return {
      status: "CLOSED",
      canUpload: false,
      canRead: false,
      canDelete: false,
      graceUntil,
      writeBlockedUntil,
      readBlockedUntil,
      purgeAt: readBlockedUntil,
      reason: "closed",
    };
  }

  const overQuota = allowance !== null && used > allowance;

  if (now.getTime() < expiry) {
    if (overQuota) {
      return {
        status: "GRACE",
        canUpload: false,
        canRead: true,
        canDelete: true,
        graceUntil,
        writeBlockedUntil,
        readBlockedUntil,
        purgeAt: null,
        reason: "grace_over_quota",
      };
    }
    return {
      status: "ACTIVE",
      canUpload: true,
      canRead: true,
      canDelete: true,
      graceUntil: null,
      writeBlockedUntil: null,
      readBlockedUntil: null,
      purgeAt: null,
      reason: "active",
    };
  }

  if (now.getTime() < graceUntil.getTime()) {
    return {
      status: "GRACE",
      canUpload: false,
      canRead: true,
      canDelete: true,
      graceUntil,
      writeBlockedUntil,
      readBlockedUntil,
      purgeAt: null,
      reason: overQuota ? "grace_over_quota" : "grace_expired_plan",
    };
  }

  if (now.getTime() < writeBlockedUntil.getTime()) {
    return {
      status: "WRITE_BLOCKED",
      canUpload: false,
      canRead: true,
      canDelete: true,
      graceUntil,
      writeBlockedUntil,
      readBlockedUntil,
      purgeAt: null,
      reason: "write_blocked",
    };
  }

  return {
    status: "READ_BLOCKED",
    canUpload: false,
    canRead: false,
    canDelete: true,
    graceUntil,
    writeBlockedUntil,
    readBlockedUntil,
    purgeAt: readBlockedUntil,
    reason: "read_blocked",
  };
}

export function daysUntil(target: Date, now: Date): number {
  return Math.ceil((target.getTime() - now.getTime()) / DAY_MS);
}
