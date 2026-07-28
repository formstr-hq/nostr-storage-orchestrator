import type { BlobRecord, PlanConfig, RelayEventRecord, UserInfo } from "./types.js";

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

  constructor(opts: { baseUrl: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
  }

  private async get<T>(path: string): Promise<T | null> {
    const res = await fetch(`${this.baseUrl}${path}`);
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
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      throw new DbApiError(res.status, await safeJson(res));
    }
    return (await res.json()) as T;
  }

  private async mutate<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      throw new DbApiError(res.status, await safeJson(res));
    }
    return (await res.json()) as T;
  }

  getPlans(): Promise<PlanConfig> {
    return this.getOk<PlanConfig>("/plans");
  }

  getUser(npub: string): Promise<UserInfo | null> {
    return this.get<UserInfo>(`/users/${encodeURIComponent(npub)}`);
  }

  upsertUser(npub: string): Promise<UserInfo> {
    return this.mutate<UserInfo>("PUT", `/users/${encodeURIComponent(npub)}`, {});
  }

  getBlob(hash: string): Promise<BlobRecord | null> {
    return this.get<BlobRecord>(`/blobs/${encodeURIComponent(hash)}`);
  }

  createBlob(data: {
    hash: string;
    npub: string;
    size: number | string;
    replicas: string[];
  }): Promise<BlobRecord & { usedStorage: string }> {
    return this.mutate("POST", "/blobs", data);
  }

  deleteBlob(hash: string): Promise<{ deleted: true; usedStorage: string }> {
    return this.mutate("DELETE", `/blobs/${encodeURIComponent(hash)}`);
  }

  getRelayEvent(eventId: string): Promise<RelayEventRecord | null> {
    return this.get<RelayEventRecord>(`/relay-events/${encodeURIComponent(eventId)}`);
  }

  createRelayEvent(data: {
    eventId: string;
    npub: string;
    kind: number;
    size: number | string;
  }): Promise<RelayEventRecord & { usedStorage: string }> {
    return this.mutate("POST", "/relay-events", data);
  }

  rollbackRelayEvent(eventId: string): Promise<{ rolledBack: boolean }> {
    return this.mutate("POST", `/relay-events/${encodeURIComponent(eventId)}/rollback`);
  }

  setRelayEventReplicas(eventId: string, replicas: string[]): Promise<{ updated: true }> {
    return this.mutate("PATCH", `/relay-events/${encodeURIComponent(eventId)}`, { replicas });
  }

  deleteRelayEvent(eventId: string): Promise<{ deleted: true }> {
    return this.mutate("DELETE", `/relay-events/${encodeURIComponent(eventId)}`);
  }
}
