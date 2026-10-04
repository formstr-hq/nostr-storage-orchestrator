export type UserStatus =
  | "UNPAID"
  | "ACTIVE"
  | "GRACE"
  | "WRITE_BLOCKED"
  | "READ_BLOCKED"
  | "CLOSED";

export interface UserInfo {
  npub: string;
  /** Internal role: "user" | "service" | "admin". */
  role: string;
  plan: string | null;
  planExpiresAt: string | null;
  storageBytes: string | null;
  status: UserStatus;
  statusChangedAt: string | null;
  termsVersion: string | null;
  termsAcceptedAt: string | null;
  usedStorage: string;
  createdAt: string;
}

export interface BlobRecord {
  hash: string;
  npub: string;
  size: string;
  replicas: string[];
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EntitlementRequest {
  plan: string;
  durationDays: number;
  storageBytes: string | number;
  termsVersion?: string;
  source: "payment" | "admin";
  mode?: "extend" | "upgrade";
  force?: boolean;
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
  byStatus: Record<string, number>;
  byPlan: Record<string, number>;
}

export type MemberRole = "CLIENT" | "ADMIN";
export type MemberStatus = "ACTIVE" | "REVOKED";
export type StorageLifecycle = "LINKED" | "REMOVED";

export interface MemberRecord {
  npub: string;
  role: MemberRole;
  status: MemberStatus;
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
