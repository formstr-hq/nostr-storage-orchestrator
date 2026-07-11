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
