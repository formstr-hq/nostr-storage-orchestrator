import { createNip98Signer, type Nip98Signer } from "@orchestrator/nip98";
import type {
  ActivePgStorageRecord,
  ActiveStorageRecord,
  BlobRecord,
  BlobWithOwners,
  CapacityRecord,
  EntitlementRequest,
  MemberRecord,
  MeshRole,
  MeshStatus,
  NotificationRecord,
  ModerationRecord,
  Paginated,
  ServiceAccountRecord,
  StorageRecord,
  StorageStats,
  StorageUpdate,
  UserInfo,
} from "./types.js";

export class DbApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`db-api request failed with status ${status}`);
    this.name = "DbApiError";
    this.status = status;
    this.body = body;
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export class DbClient {
  private baseUrl: string;
  private signer: Nip98Signer | undefined;

  /**
   * `serviceNsec` is the machine identity used to sign internal requests with
   * NIP-98; the resulting npub must have role service/admin in db-api. It is
   * optional so read-only/dev callers keep working against open endpoints.
   */
  constructor(opts: { baseUrl: string; serviceNsec?: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.signer = opts.serviceNsec ? createNip98Signer(opts.serviceNsec) : undefined;
  }

  get serviceNpub(): string | undefined {
    return this.signer?.npub;
  }

  private headers(method: string, path: string, body?: unknown, includeContentType = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (includeContentType) headers["content-type"] = "application/json";
    if (this.signer) {
      headers["authorization"] = this.signer.header(method, `${this.baseUrl}${path}`, body);
    }
    return headers;
  }

  private async get<T>(path: string): Promise<T | null> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers("GET", path) });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new DbApiError(res.status, await safeJson(res));
    }
    return (await res.json()) as T;
  }

  // Like get(), but for endpoints that never 404 (e.g. static config) — a
  // non-2xx is always an error, never a valid "not found" outcome.
  private async getOk<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers("GET", path) });
    if (!res.ok) {
      throw new DbApiError(res.status, await safeJson(res));
    }
    return (await res.json()) as T;
  }

  private async mutate<T>(method: string, path: string, body?: unknown): Promise<T> {
    const serialized = JSON.stringify(body ?? {});
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(method, path, body ?? {}, true),
      body: serialized,
    });
    if (!res.ok) {
      throw new DbApiError(res.status, await safeJson(res));
    }
    return (await res.json()) as T;
  }

  getUser(npub: string): Promise<UserInfo | null> {
    return this.get<UserInfo>(`/users/${encodeURIComponent(npub)}`);
  }

  getBlob(hash: string): Promise<BlobWithOwners | null> {
    return this.get<BlobWithOwners>(`/blobs/${encodeURIComponent(hash)}`);
  }

  getCapacity(): Promise<CapacityRecord> {
    return this.getOk("/storages/capacity");
  }

  totalBlobSize(): Promise<{ totalSize: string }> {
    return this.getOk("/blobs/total");
  }

  createBlob(data: {
    hash: string;
    npub: string;
    size: number | string;
    replicas: string[];
  }): Promise<BlobRecord & { usedStorage: string }> {
    return this.mutate("POST", "/blobs", data);
  }

  /**
   * Removes one owner's row (`{ npub }`) or every owner's (`{ all: true }`,
   * moderation). `remainingOwners` > 0 means the bytes must stay on the nodes.
   */
  deleteBlob(
    hash: string,
    target: { npub: string } | { all: true },
  ): Promise<{ deleted: true; usedStorage: string; remainingOwners: number }> {
    const query = "all" in target ? "all=true" : `npub=${encodeURIComponent(target.npub)}`;
    return this.mutate("DELETE", `/blobs/${encodeURIComponent(hash)}?${query}`);
  }

  // ── Entitlements / account / admin ────────────────────────────────────────

  assignEntitlement(npub: string, request: EntitlementRequest): Promise<UserInfo> {
    return this.mutate("POST", `/users/${encodeURIComponent(npub)}/entitlement`, request);
  }

  listUsers(
    filters: { query?: string; page?: number; pageSize?: number } = {},
  ): Promise<Paginated<UserInfo>> {
    const query = new URLSearchParams();
    if (filters.query) query.set("query", filters.query);
    if (filters.page) query.set("page", String(filters.page));
    if (filters.pageSize) query.set("pageSize", String(filters.pageSize));
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.getOk(`/users${suffix}`);
  }

  listAttentionUsers(page = 1, pageSize = 100): Promise<Paginated<UserInfo>> {
    return this.getOk(`/users/attention?page=${page}&pageSize=${pageSize}`);
  }

  listUserBlobs(npub: string, page = 1, pageSize = 25): Promise<Paginated<BlobRecord>> {
    return this.getOk(
      `/users/${encodeURIComponent(npub)}/blobs?page=${page}&pageSize=${pageSize}`,
    );
  }

  listUserNotifications(npub: string, page = 1, pageSize = 25): Promise<Paginated<NotificationRecord>> {
    return this.getOk(
      `/users/${encodeURIComponent(npub)}/notifications?page=${page}&pageSize=${pageSize}`,
    );
  }

  purgeUserBlobs(npub: string): Promise<{ deleted: number }> {
    return this.mutate("DELETE", `/users/${encodeURIComponent(npub)}/blobs`);
  }

  listAllBlobs(
    filters: { hash?: string; npub?: string; query?: string; page?: number; pageSize?: number } = {},
  ): Promise<Paginated<BlobRecord>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.getOk(`/blobs${suffix}`);
  }

  storageStats(): Promise<StorageStats> {
    return this.getOk("/storage-stats");
  }

  // Returns true when the row was created, false when it already existed
  // (409 from the unique key) — the notifier uses this for dedupe.
  async logNotification(data: {
    npub: string;
    kind: string;
    ref?: string | null;
    channel: string;
  }): Promise<boolean> {
    try {
      await this.mutate("POST", "/notifications", data);
      return true;
    } catch (error) {
      if (error instanceof DbApiError && error.status === 409) {
        return false;
      }
      throw error;
    }
  }

  listNotifications(npub: string, page = 1, pageSize = 25): Promise<Paginated<NotificationRecord>> {
    return this.getOk(
      `/notifications?npub=${encodeURIComponent(npub)}&page=${page}&pageSize=${pageSize}`,
    );
  }

  recordModeration(data: {
    hash: string;
    npub: string;
    adminNpub: string;
    reason: string;
  }): Promise<ModerationRecord> {
    return this.mutate("POST", "/moderation", data);
  }

  listModeration(
    filters: { hash?: string; npub?: string; page?: number; pageSize?: number } = {},
  ): Promise<Paginated<ModerationRecord>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.getOk(`/moderation${suffix}`);
  }

  getServiceAccount(npub: string): Promise<ServiceAccountRecord | null> {
    return this.get<ServiceAccountRecord>(`/service-accounts/${encodeURIComponent(npub)}`);
  }

  listServiceAccounts(filters: { enabled?: boolean; page?: number; pageSize?: number } = {}): Promise<Paginated<ServiceAccountRecord>> {
    const query = new URLSearchParams();
    if (filters.enabled !== undefined) query.set("enabled", String(filters.enabled));
    if (filters.page) query.set("page", String(filters.page));
    if (filters.pageSize) query.set("pageSize", String(filters.pageSize));
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.getOk(`/service-accounts${suffix}`);
  }

  getMember(npub: string): Promise<MemberRecord | null> {
    return this.get<MemberRecord>(`/members/${encodeURIComponent(npub)}`);
  }

  listMembers(filters: { role?: MeshRole; status?: MeshStatus } = {}): Promise<Array<MemberRecord & { storageCount: number }>> {
    const query = new URLSearchParams();
    if (filters.role) query.set("role", filters.role);
    if (filters.status) query.set("status", filters.status);
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.getOk(`/members${suffix}`);
  }

  putMember(npub: string, data: { role?: MeshRole; addedByNpub?: string | null }): Promise<MemberRecord> {
    return this.mutate("PUT", `/members/${encodeURIComponent(npub)}`, data);
  }

  deleteMember(npub: string): Promise<MemberRecord> {
    return this.mutate("DELETE", `/members/${encodeURIComponent(npub)}`);
  }

  getStorage(npub: string): Promise<StorageRecord | null> {
    return this.get<StorageRecord>(`/storages/${encodeURIComponent(npub)}`);
  }

  listStorages(ownerNpub?: string): Promise<StorageRecord[]> {
    const suffix = ownerNpub === undefined ? "" : `?ownerNpub=${encodeURIComponent(ownerNpub)}`;
    return this.getOk(`/storages${suffix}`);
  }

  listActiveStorages(): Promise<ActiveStorageRecord[]> {
    return this.getOk("/storages/active");
  }

  listActivePgStorages(): Promise<ActivePgStorageRecord[]> {
    return this.getOk("/storages/active-pg");
  }

  createStorage(data: {
    npub: string;
    ownerNpub: string;
    declaredCapacityBytes?: string | number | null;
  }): Promise<StorageRecord> {
    return this.mutate("POST", "/storages", data);
  }

  updateStorage(npub: string, data: StorageUpdate): Promise<StorageRecord> {
    return this.mutate("PATCH", `/storages/${encodeURIComponent(npub)}`, data);
  }

  deleteStorage(npub: string): Promise<StorageRecord> {
    return this.mutate("DELETE", `/storages/${encodeURIComponent(npub)}`);
  }

  backfillReplicaIds(dryRun = false): Promise<{
    dryRun: boolean;
    changedRows: number;
    replacedValues: number;
    unmatchedValues: number;
  }> {
    return this.mutate("POST", "/storages/backfill-replicas", { dryRun });
  }
}
