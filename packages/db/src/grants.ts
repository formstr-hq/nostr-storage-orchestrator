import { randomUUID } from "node:crypto";
import { nip19 } from "nostr-tools";

/**
 * A grant is one entitlement with its own start and expiry. The effective
 * allowance at a point in time is the sum of the grants active then; nothing
 * is overwritten when a new grant arrives.
 */
export const GRANT_SOURCES = ["payment", "workspace", "admin", "legacy"] as const;
export type GrantSource = (typeof GRANT_SOURCES)[number];

export class GrantError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "GrantError";
    this.status = status;
    this.code = code;
  }
}

export interface GrantLike {
  startsAt: Date | string;
  expiresAt: Date | string;
  storageBytes: bigint | number | string;
}

export interface GrantSummary {
  activeStorageBytes: bigint;
  /** Latest expiry across every grant; drives the account lifecycle clock. */
  lastExpiresAt: Date | null;
  /** Earliest expiry among active grants; drives "storage drops on…" notices. */
  nextExpiresAt: Date | null;
  activeCount: number;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Pure aggregate over a holder's grants. A grant contributes bytes only while
 * `startsAt <= now < expiresAt`; `lastExpiresAt` intentionally includes expired
 * grants so the lifecycle (grace → write-blocked → read-blocked) starts when
 * the *last* grant lapses, not when the first one does.
 */
export function summarizeGrants(grants: readonly GrantLike[], now = new Date()): GrantSummary {
  let activeStorageBytes = 0n;
  let lastExpiresAt: Date | null = null;
  let nextExpiresAt: Date | null = null;
  let activeCount = 0;

  for (const grant of grants) {
    const startsAt = toDate(grant.startsAt);
    const expiresAt = toDate(grant.expiresAt);
    if (lastExpiresAt === null || expiresAt.getTime() > lastExpiresAt.getTime()) {
      lastExpiresAt = expiresAt;
    }
    if (startsAt.getTime() <= now.getTime() && now.getTime() < expiresAt.getTime()) {
      activeCount += 1;
      activeStorageBytes += BigInt(grant.storageBytes);
      if (nextExpiresAt === null || expiresAt.getTime() < nextExpiresAt.getTime()) {
        nextExpiresAt = expiresAt;
      }
    }
  }

  return { activeStorageBytes, lastExpiresAt, nextExpiresAt, activeCount };
}

export interface ParsedGrantRequest {
  planId: string | null;
  storageBytes: bigint;
  startsAt: Date;
  expiresAt: Date;
  source: GrantSource;
  sourceRef: string | null;
}

const MAX_SOURCE_REF = 256;

function parseSourceRef(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GrantError(400, "invalid_source_ref");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_SOURCE_REF) throw new GrantError(400, "invalid_source_ref");
  return trimmed;
}

function parsePlanId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[a-z0-9_-]+$/i.test(value) || value.length > 64) {
    throw new GrantError(400, "invalid_plan_id");
  }
  return value.toLowerCase();
}

function parseBytes(value: unknown): bigint {
  let bytes: bigint;
  try {
    bytes = BigInt(value as string | number | bigint);
  } catch {
    throw new GrantError(400, "invalid_storage_bytes");
  }
  if (bytes <= 0n) throw new GrantError(400, "invalid_storage_bytes");
  return bytes;
}

/**
 * `POST /users/:npub/grants` body. Either `durationDays` (starts now) or an
 * explicit `expiresAt` (backfill/admin reconciliation); `startsAt` defaults to
 * now and is only needed when replaying a historical grant.
 */
export function parseAddGrantRequest(body: unknown, now = new Date()): ParsedGrantRequest {
  if (!body || typeof body !== "object") throw new GrantError(400, "invalid_grant");
  const b = body as Record<string, unknown>;

  const storageBytes = parseBytes(b.storageBytes);
  const source = b.source;
  if (typeof source !== "string" || !GRANT_SOURCES.includes(source as GrantSource)) {
    throw new GrantError(400, "invalid_source");
  }

  const startsAt =
    b.startsAt === undefined
      ? now
      : new Date(typeof b.startsAt === "string" ? b.startsAt : NaN);
  if (Number.isNaN(startsAt.getTime())) throw new GrantError(400, "invalid_starts_at");

  let expiresAt: Date;
  if (b.expiresAt !== undefined) {
    expiresAt = new Date(typeof b.expiresAt === "string" ? b.expiresAt : NaN);
    if (Number.isNaN(expiresAt.getTime())) throw new GrantError(400, "invalid_expires_at");
  } else {
    const durationDays = b.durationDays;
    if (
      typeof durationDays !== "number" ||
      !Number.isInteger(durationDays) ||
      durationDays <= 0 ||
      durationDays > 36500
    ) {
      throw new GrantError(400, "invalid_duration");
    }
    expiresAt = new Date(startsAt.getTime() + durationDays * 24 * 60 * 60 * 1000);
  }
  if (expiresAt.getTime() <= startsAt.getTime()) {
    throw new GrantError(400, "invalid_expiry");
  }

  return {
    planId: parsePlanId(b.planId),
    storageBytes,
    startsAt,
    expiresAt,
    source: source as GrantSource,
    sourceRef: parseSourceRef(b.sourceRef),
  };
}

/**
 * Translate the old single-entitlement body into a grant. The old endpoint is
 * kept as a compatibility shim while backend callers move over; `mode`,
 * `force` and `durationFrom` are deliberately ignored because grants never
 * overwrite one another.
 */
export function parseLegacyEntitlement(body: unknown, now = new Date()): ParsedGrantRequest {
  if (!body || typeof body !== "object") throw new GrantError(400, "invalid_entitlement");
  const b = body as Record<string, unknown>;
  const source = b.source === "payment" || b.source === "admin" ? b.source : null;
  if (!source) throw new GrantError(400, "invalid_source");

  const storageBytes = parseBytes(b.storageBytes);
  const durationDays = b.durationDays;
  if (typeof durationDays !== "number" || !Number.isInteger(durationDays) || durationDays <= 0) {
    throw new GrantError(400, "invalid_duration");
  }

  let expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
  if (b.planExpiresAt !== undefined) {
    if (source !== "admin") throw new GrantError(403, "expiry_override_requires_admin");
    expiresAt = new Date(typeof b.planExpiresAt === "string" ? b.planExpiresAt : NaN);
    if (Number.isNaN(expiresAt.getTime())) throw new GrantError(400, "invalid_plan_expires_at");
  }

  let sourceRef: string | null = null;
  if (b.paymentHash !== undefined) {
    if (typeof b.paymentHash !== "string" || !/^[0-9a-f]{64}$/i.test(b.paymentHash)) {
      throw new GrantError(400, "invalid_payment_hash");
    }
    sourceRef = b.paymentHash.toLowerCase();
  } else if (source === "admin") {
    sourceRef = `admin:${randomUUID()}`;
  }
  if (source === "payment" && sourceRef === null) {
    throw new GrantError(400, "payment_hash_required");
  }

  return {
    planId: parsePlanId(b.planId),
    storageBytes,
    startsAt: now,
    expiresAt,
    source,
    sourceRef,
  };
}

/**
 * The owner a workspace seat grant belongs to. New seat grants encode the
 * owner in `sourceRef`; the backend writes the owner's **hex** pubkey, so both
 * hex and npub are accepted and normalized to npub. Legacy domain-scoped refs
 * have no owner to return to.
 */
const WORKSPACE_OWNER_REF = /^workspace:owner:(npub1[0-9a-z]+|[0-9a-f]{64}):/;

export function workspaceSeatOwner(sourceRef: string | null | undefined): string | null {
  const owner = WORKSPACE_OWNER_REF.exec(sourceRef ?? "")?.[1];
  if (!owner) return null;
  if (owner.startsWith("npub1")) return owner;
  try {
    return nip19.npubEncode(owner);
  } catch {
    // A malformed owner ref must not fail the purge; the grant simply falls
    // through to the account's normal deletion path.
    return null;
  }
}

/**
 * `POST /users/grants/transfer` body. Used for workspace seats: the *same*
 * grant changes holder, so expiresAt/storageBytes are untouched. At least one
 * selector (source or sourceRefPrefix) is required so a seat transfer can never
 * accidentally move a paid grant.
 */
export interface ParsedTransferRequest {
  fromNpub: string;
  toNpub: string;
  source: GrantSource | null;
  sourceRefPrefix: string | null;
  count: number;
}

export function parseTransferRequest(body: unknown): ParsedTransferRequest {
  if (!body || typeof body !== "object") throw new GrantError(400, "invalid_transfer");
  const b = body as Record<string, unknown>;

  const fromNpub = b.fromNpub;
  const toNpub = b.toNpub;
  if (typeof fromNpub !== "string" || !fromNpub.startsWith("npub1")) {
    throw new GrantError(400, "invalid_from_npub");
  }
  if (typeof toNpub !== "string" || !toNpub.startsWith("npub1")) {
    throw new GrantError(400, "invalid_to_npub");
  }
  if (fromNpub === toNpub) throw new GrantError(400, "same_holder");

  const source =
    b.source === undefined ? null : (b.source as GrantSource);
  if (source !== null && !GRANT_SOURCES.includes(source)) {
    throw new GrantError(400, "invalid_source");
  }
  const sourceRefPrefix =
    b.sourceRefPrefix === undefined ? null : parseSourceRef(b.sourceRefPrefix);
  if (source === null && sourceRefPrefix === null) {
    throw new GrantError(400, "selector_required");
  }

  const rawCount = b.count === undefined ? 1 : b.count;
  if (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount <= 0 || rawCount > 100) {
    throw new GrantError(400, "invalid_count");
  }

  return { fromNpub, toNpub, source, sourceRefPrefix, count: rawCount };
}
