export interface StorageGrantInfo {
  id: string;
  npub: string;
  planId: string | null;
  storageBytes: string;
  startsAt: string;
  expiresAt: string;
  source: string;
  sourceRef: string | null;
  createdAt: string;
}

export interface UserInfo {
  npub: string;
  /** Derived: latest grant expiry (the account lifecycle clock). */
  planExpiresAt: string | null;
  /** Derived: sum of grants active right now; null when the user has no grants. */
  storageBytes: string | null;
  usedStorage: string;
  createdAt: string;
  /** Derived: earliest expiry among active grants, for drop warnings. */
  nextExpiresAt: string | null;
  grants: StorageGrantInfo[];
}

export type GrantSource = "payment" | "workspace" | "admin" | "legacy";

export interface AddGrantRequest {
  planId?: string | null;
  storageBytes: string | number;
  /** Ignored when `expiresAt` is supplied. */
  durationDays?: number;
  startsAt?: string;
  expiresAt?: string;
  source: GrantSource;
  sourceRef?: string;
}

export interface TransferGrantsRequest {
  fromNpub: string;
  toNpub: string;
  source?: GrantSource;
  /** e.g. "workspace:42:" — the seat's identity prefix. */
  sourceRefPrefix?: string;
  count?: number;
}

export interface TransferGrantsResult {
  moved: number;
  from: UserInfo;
  to: UserInfo;
}

export interface BlobRecord {
  hash: string;
  npub: string;
  size: string;
  replicas: string[];
  createdAt: string;
}

/** One owner's pin on a blob (the row's creation time is the pin time). */
export interface BlobPin {
  npub: string;
  createdAt: string;
}

/** A blob as returned by GET /blobs/:hash: one row plus everyone billed for it. */
export interface BlobWithOwners extends BlobRecord {
  owners: string[];
  /** Per-owner pins; `owners` is kept for callers that only need the npubs. */
  pins: BlobPin[];
}

export interface CapacityRecord {
  providers: number;
  replicas: number;
  totalBytes: string;
  freeBytes: string;
  committedBytes: string;
  availableBytes: string;
  minFreeBytes: string;
  signupsOpen: boolean;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EntitlementRequest {
  durationDays: number;
  storageBytes: string | number;
  source: "payment" | "admin";
  /**
   * Accepted for wire compatibility with older callers; grants are additive,
   * so mode/force no longer change the outcome.
   */
  mode?: "extend" | "upgrade";
  force?: boolean;
  /** Required for source "payment"; makes the grant idempotent. */
  paymentHash?: string;
}

export interface NotificationRecord {
  id: string;
  npub: string;
  kind: string;
  ref: string | null;
  channel: string;
  sentAt: string;
}

export interface ModerationRecord {
  id: string;
  hash: string;
  npub: string;
  adminNpub: string;
  reason: string;
  createdAt: string;
}

export interface StorageStats {
  users: number;
  blobs: number;
  bytes: string;
}

export interface ServiceAccountRecord {
  npub: string;
  label: string | null;
  enabled: boolean;
  createdAt: string;
}

export type MeshRole = "CLIENT" | "ADMIN";
export type MeshStatus = "ACTIVE" | "REVOKED";
export type StorageLifecycle = "LINKED" | "REMOVED";

export interface MemberRecord {
  npub: string;
  role: MeshRole;
  status: MeshStatus;
  addedByNpub: string | null;
  createdAt: string;
  updatedAt: string;
  storageCount?: number;
}

export interface StorageRecord {
  npub: string;
  ownerNpub: string;
  tunnelIp: string | null;
  blossomPort: number | null;
  pgAgentPort: number | null;
  declaredCapacityBytes: string | null;
  reportedTotalBytes: string | null;
  reportedFreeBytes: string | null;
  lifecycle: StorageLifecycle;
  lastPingAt: string | null;
  createdAt: string;
}

export interface ActiveStorageRecord extends StorageRecord {
  tunnelIp: string;
  blossomPort: number;
  lifecycle: "LINKED";
  lastPingAt: string;
}

export interface ActivePgStorageRecord extends ActiveStorageRecord {
  pgAgentPort: number;
}

export interface StorageUpdate {
  tunnelIp?: string | null;
  blossomPort?: number | null;
  pgAgentPort?: number | null;
  declaredCapacityBytes?: string | number | null;
  reportedTotalBytes?: string | number | null;
  reportedFreeBytes?: string | number | null;
  lifecycle?: StorageLifecycle;
  lastPingAt?: string | null;
}
