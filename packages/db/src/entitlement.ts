import type { User } from "./prisma.js";

export type EntitlementMode = "extend" | "upgrade";
export type EntitlementSource = "payment" | "admin";

export interface EntitlementRequest {
  plan: string;
  durationDays: number;
  storageBytes: number | string;
  termsVersion?: string | null;
  source: EntitlementSource;
  mode?: EntitlementMode;
  force?: boolean;
  /**
   * Admin-only explicit expiry override (ISO). Used to reconcile a lapsed
   * grant and by the smoke suite to simulate time passing; not accepted from
   * payment sources.
   */
  planExpiresAt?: string;
}

export interface ParsedEntitlementRequest extends EntitlementRequest {
  storageBytesBig: bigint;
  planExpiresAt?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DURATION_DAYS = 36500;

export class EntitlementError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "EntitlementError";
    this.status = status;
    this.code = code;
  }
}

export function parseEntitlementRequest(body: unknown): ParsedEntitlementRequest {
  if (!body || typeof body !== "object") {
    throw new EntitlementError(400, "invalid_entitlement");
  }
  const b = body as Record<string, unknown>;

  const plan = b.plan;
  const durationDays = b.durationDays;
  const source = b.source;

  if (typeof plan !== "string" || plan.length === 0 || plan.length > 64) {
    throw new EntitlementError(400, "invalid_plan");
  }
  if (
    typeof durationDays !== "number" ||
    !Number.isInteger(durationDays) ||
    durationDays <= 0 ||
    durationDays > MAX_DURATION_DAYS
  ) {
    throw new EntitlementError(400, "invalid_duration");
  }
  if (source !== "payment" && source !== "admin") {
    throw new EntitlementError(400, "invalid_source");
  }

  let storageBytesBig: bigint;
  try {
    storageBytesBig = BigInt(b.storageBytes as string | number);
  } catch {
    throw new EntitlementError(400, "invalid_storage_bytes");
  }
  if (storageBytesBig <= 0n) {
    throw new EntitlementError(400, "invalid_storage_bytes");
  }

  const mode = b.mode;
  if (mode !== undefined && mode !== "extend" && mode !== "upgrade") {
    throw new EntitlementError(400, "invalid_mode");
  }

  const force = b.force === true;
  if (force && source !== "admin") {
    throw new EntitlementError(403, "force_requires_admin");
  }

  const result: ParsedEntitlementRequest = {
    plan,
    durationDays,
    storageBytes: b.storageBytes as number | string,
    source,
    storageBytesBig,
  };
  if (typeof b.termsVersion === "string" && b.termsVersion.length > 0) {
    result.termsVersion = b.termsVersion;
  }
  if (mode === "extend" || mode === "upgrade") result.mode = mode;
  if (force) result.force = true;

  if (b.planExpiresAt !== undefined) {
    if (source !== "admin") {
      throw new EntitlementError(403, "expiry_override_requires_admin");
    }
    if (typeof b.planExpiresAt !== "string" || Number.isNaN(new Date(b.planExpiresAt).getTime())) {
      throw new EntitlementError(400, "invalid_plan_expires_at");
    }
    result.planExpiresAt = b.planExpiresAt;
  }

  return result;
}

export interface EntitlementEffect {
  plan: string;
  planExpiresAt: Date;
  storageBytes: bigint;
  status: "ACTIVE" | "GRACE";
  termsVersion: string | null;
  termsAcceptedAt: Date;
}

type UserEntitlement = Pick<
  User,
  "plan" | "planExpiresAt" | "storageBytes" | "usedStorage" | "termsVersion"
>;

/**
 * Pure computation of the new entitlement fields for a user. Kept separate
 * from Prisma so it is directly unit-testable and the route handler stays a
 * single transaction wrapper.
 *
 * `mode` is normally supplied by formstr-backend, which owns the plan
 * catalog and derives it from `rank`. When it is absent db-api can only
 * safely extend a non-live plan; extending a live plan without knowing the
 * ranks could silently downgrade, so that combination is rejected with
 * `mode_required` as a final invariant.
 */
export function computeEntitlement(
  user: UserEntitlement,
  request: ParsedEntitlementRequest,
  now: Date = new Date(),
): EntitlementEffect {
  const live =
    user.plan !== null &&
    user.planExpiresAt !== null &&
    user.planExpiresAt.getTime() > now.getTime();

  if (live && !request.force && request.mode === undefined) {
    throw new EntitlementError(409, "mode_required");
  }

  const mode: EntitlementMode = request.mode ?? "extend";

  const base = Math.max(now.getTime(), user.planExpiresAt?.getTime() ?? 0);
  const planExpiresAt = new Date(base + request.durationDays * DAY_MS);

  let plan: string;
  let storageBytes: bigint;
  let termsVersion: string | null;

  if (mode === "upgrade") {
    plan = request.plan;
    storageBytes = request.storageBytesBig;
    termsVersion = request.termsVersion ?? null;
  } else {
    // extend: only set the plan when there is no live plan. A renewal of a
    // still-live plan leaves plan/allowance untouched. An admin force is an
    // explicit override and always applies the requested plan/allowance.
    const preserve = live && !request.force;
    plan = preserve ? user.plan! : request.plan;
    storageBytes = preserve ? user.storageBytes! : request.storageBytesBig;
    termsVersion = request.termsVersion ?? user.termsVersion ?? null;
  }

  // Admin expiry override wins over the computed expiry (ops reconciliation).
  const status = user.usedStorage > storageBytes ? "GRACE" : "ACTIVE";

  return {
    plan,
    planExpiresAt: request.planExpiresAt ? new Date(request.planExpiresAt) : planExpiresAt,
    storageBytes,
    status,
    termsVersion,
    termsAcceptedAt: now,
  };
}
