import type { Identities } from "./nostr";
import { blossomAuth, nip98Auth } from "./nostr";
import type {
  Account,
  Blob,
  InvoiceRecord,
  ModerationRecord,
  NotificationRecord,
  Paginated,
  StorageStats,
  StorageSubscription,
  StorageTier,
  UserStatus,
} from "./types";

/** Same origin in production; overridable for local dev split origins. */
export const BACKEND_URL: string =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? "https://api.formstr.app";
export const BLOSSOM_URL: string =
  (import.meta.env.VITE_BLOSSOM_URL as string | undefined) ?? "";

function url(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

// NIP-98 binds a signature to an absolute URL, so same-origin calls (empty
// base) must still be signed with the window origin.
function absolute(base: string, path: string): string {
  const target = url(base, path);
  if (/^https?:\/\//i.test(target)) return target;
  return `${window.location.origin}${target}`;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const error = new Error(
      (body && (body.error || body.message)) || `request failed (${res.status})`,
    ) as Error & { status?: number; body?: unknown };
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body as T;
}

// ── Blossom proxy (same origin in production) ────────────────────────────────

export async function getStorage(identities: Identities): Promise<Account> {
  const auth = await blossomAuth(identities, "get");
  return parse<Account>(await fetch(url(BLOSSOM_URL, "/storage"), { headers: { authorization: auth } }));
}

export async function getAccount(identities: Identities): Promise<Account> {
  const auth = await blossomAuth(identities, "get");
  return parse<Account>(await fetch(url(BLOSSOM_URL, "/account"), { headers: { authorization: auth } }));
}

export async function listBlobs(
  identities: Identities,
  page = 1,
  pageSize = 25,
): Promise<Paginated<Blob>> {
  const auth = await blossomAuth(identities, "list");
  return parse<Paginated<Blob>>(
    await fetch(url(BLOSSOM_URL, `/account/blobs?page=${page}&pageSize=${pageSize}`), {
      headers: { authorization: auth },
    }),
  );
}

export async function listNotifications(
  identities: Identities,
  page = 1,
): Promise<Paginated<NotificationRecord>> {
  const auth = await blossomAuth(identities, "list");
  return parse<Paginated<NotificationRecord>>(
    await fetch(url(BLOSSOM_URL, `/account/notifications?page=${page}&pageSize=25`), {
      headers: { authorization: auth },
    }),
  );
}

export async function deleteBlob(identities: Identities, hash: string): Promise<void> {
  const auth = await blossomAuth(identities, "delete", { hash });
  await parse(
    await fetch(url(BLOSSOM_URL, `/${hash}`), {
      method: "DELETE",
      headers: { authorization: auth },
    }),
  );
}

// ── formstr-backend (plans, invoices, role) ───────────────────────────────────

export async function listTiers(): Promise<StorageTier[]> {
  return parse<StorageTier[]>(await fetch(url(BACKEND_URL, "/api/tiers/storage")));
}

/**
 * Whether new customers can sign up. Closes when the storage providers have no
 * room left; existing customers can always renew. Unknown counts as open here
 * (the backend still refuses a new signup it cannot verify).
 */
export async function getSignupsOpen(): Promise<boolean> {
  try {
    const result = await parse<{ signupsOpen: boolean }>(
      await fetch(url(BACKEND_URL, "/api/storage/availability")),
    );
    return result.signupsOpen;
  } catch (err) {
    const body = (err as { body?: { signupsOpen?: boolean } }).body;
    return body?.signupsOpen ?? true;
  }
}

export async function myInvoices(identities: Identities): Promise<InvoiceRecord[]> {
  const target = url(BACKEND_URL, "/api/invoices");
  const auth = await nip98Auth(identities, absolute(BACKEND_URL, "/api/invoices"), "GET");
  return parse<InvoiceRecord[]>(await fetch(target, { headers: { authorization: auth } }));
}

export async function generateStorageInvoice(
  identities: Identities,
  body: { plan: string; termsAccepted: boolean; termsVersion: string },
): Promise<{ invoice: string; paymentHash: string; amount: number }> {
  const target = url(BACKEND_URL, "/api/generate-invoice/storage");
  const auth = await nip98Auth(identities, absolute(BACKEND_URL, "/api/generate-invoice/storage"), "POST", body);
  return parse(
    await fetch(target, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function getMe(
  identities: Identities,
): Promise<{ pubkey: string; role: string | null }> {
  const target = url(BACKEND_URL, "/api/auth/me");
  const auth = await nip98Auth(identities, absolute(BACKEND_URL, "/api/auth/me"), "GET");
  return parse(await fetch(target, { headers: { authorization: auth } }));
}

/**
 * The signed-in user's storage plan as owned by the backend (labels, features
 * and purchase history). The enforced expiry/allowance/usage come from the
 * orchestrator via `/storage`; this endpoint adds the catalog plan.
 */
export async function getStorageSubscription(
  identities: Identities,
): Promise<StorageSubscription> {
  const target = url(BACKEND_URL, "/api/storage/subscription");
  const auth = await nip98Auth(identities, absolute(BACKEND_URL, "/api/storage/subscription"), "GET");
  return parse(await fetch(target, { headers: { authorization: auth } }));
}

export function watchInvoice(
  backendUrl: string,
  paymentHash: string,
  onPaid: () => void,
  onError?: (error: Error) => void,
): () => void {
  const wsUrl = backendUrl.replace(/^http/, "ws").replace(/\/+$/, "");
  const socket = new WebSocket(`${wsUrl}/?hash=${encodeURIComponent(paymentHash)}`);
  let closed = false;
  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data as string) as { status?: string };
      if (message.status === "paid") {
        closed = true;
        socket.close();
        onPaid();
      }
    } catch {
      // ignore non-JSON frames
    }
  };
  socket.onerror = () => onError?.(new Error("invoice socket error"));
  return () => {
    if (!closed) socket.close();
  };
}

// ── Admin (proxied by the Blossom server) ─────────────────────────────────────

async function adminGet<T>(identities: Identities, path: string, query = ""): Promise<T> {
  const target = `${path}${query}`;
  const auth = await nip98Auth(identities, absolute(BLOSSOM_URL, target), "GET");
  return parse<T>(await fetch(url(BLOSSOM_URL, target), { headers: { authorization: auth } }));
}

async function adminSend<T>(
  identities: Identities,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const auth = await nip98Auth(identities, absolute(BLOSSOM_URL, path), method, body);
  return parse<T>(
    await fetch(url(BLOSSOM_URL, path), {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

export interface AdminUser {
  npub: string;
  planExpiresAt: string | null;
  storageBytes: string | null;
  status: UserStatus;
  usedStorage: string;
  createdAt: string;
}

export function adminListUsers(
  identities: Identities,
  filters: { query?: string; page?: number } = {},
): Promise<Paginated<AdminUser>> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, String(value));
  }
  return adminGet(identities, "/admin/users", params.size ? `?${params}` : "");
}

export function adminListBlobs(
  identities: Identities,
  filters: { hash?: string; npub?: string; page?: number } = {},
): Promise<Paginated<Blob>> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, String(value));
  }
  return adminGet(identities, "/admin/blobs", params.size ? `?${params}` : "");
}

export function adminStats(identities: Identities): Promise<StorageStats> {
  return adminGet(identities, "/admin/storage-stats");
}

export function adminAudit(identities: Identities): Promise<Paginated<ModerationRecord>> {
  return adminGet(identities, "/admin/audit");
}

export function adminGrantPlan(
  identities: Identities,
  npub: string,
  request: Record<string, unknown>,
): Promise<AdminUser> {
  return adminSend(identities, "POST", `/admin/users/${encodeURIComponent(npub)}/entitlement`, request);
}

export function adminForceStatus(
  identities: Identities,
  npub: string,
  status: UserStatus,
): Promise<AdminUser> {
  return adminSend(identities, "PATCH", `/admin/users/${encodeURIComponent(npub)}/status`, { status });
}

export function adminDeleteBlob(
  identities: Identities,
  hash: string,
  reason: string,
): Promise<{ deleted: true }> {
  return adminSend(identities, "DELETE", `/admin/blobs/${encodeURIComponent(hash)}`, { reason });
}

export function formatBytes(value: string | number | bigint | null | undefined): string {
  if (value === null || value === undefined) return "unlimited";
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return String(value);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n.toFixed(n >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
