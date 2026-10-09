export type UserStatus =
  | "UNPAID"
  | "ACTIVE"
  | "GRACE"
  | "WRITE_BLOCKED"
  | "READ_BLOCKED"
  | "CLOSED";

export interface Account {
  npub: string;
  /** Plan label is owned by formstr-backend; only the enforced fields live here. */
  planExpiresAt: string | null;
  storageBytes: string | null;
  status: UserStatus;
  usedStorage: string;
  createdAt: string;
  canUpload: boolean;
  canRead: boolean;
  purgeAt: string | null;
}

export interface Blob {
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

export interface NotificationRecord {
  id: string;
  npub: string;
  kind: string;
  ref: string | null;
  channel: string;
  sentAt: string;
}

export interface InvoiceRecord {
  id: number;
  product: string;
  pubkey: string;
  paymentHash: string;
  lnInvoice: string | null;
  created_at: string;
}

export interface StorageTier {
  id: string;
  name: string;
  rank: number;
  priceSats: number;
  durationDays: number;
  storageBytes: number;
  features: string[];
  /** Announced but not yet purchasable; rendered as a "Coming soon" card. */
  comingSoon?: boolean;
}

/** Response of formstr-backend GET /api/storage/subscription. */
export interface StorageSubscription {
  plan: StorageTier | null;
  planExpiresAt: string | null;
  storageBytes: string | null;
  usedStorage: string | null;
  termsVersion: string | null;
  createdAt: string | null;
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
