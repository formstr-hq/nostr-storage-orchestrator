export type Plan = "FREE" | "BASIC" | "PRO";

export interface PlanLimits {
  storageLimit: number;
  uploadLimit: number;
  replicaCount: number;
}

export type PlanConfig = Record<Plan, PlanLimits>;

export interface UserInfo {
  npub: string;
  plan: Plan;
  usedStorage: string;
}

export interface BlobRecord {
  hash: string;
  npub: string;
  size: string;
  replicas: string[];
  createdAt: string;
}

export interface RelayEventRecord {
  eventId: string;
  npub: string;
  kind: number;
  size: string;
  replicas: string[];
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
  relayPort: number | null;
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
  relayPort: number;
  lifecycle: "LINKED";
  lastPingAt: string;
}

export interface StorageUpdate {
  tunnelIp?: string | null;
  blossomPort?: number | null;
  relayPort?: number | null;
  declaredCapacityBytes?: string | number | null;
  reportedTotalBytes?: string | number | null;
  reportedFreeBytes?: string | number | null;
  lifecycle?: StorageLifecycle;
  lastPingAt?: string | null;
}
