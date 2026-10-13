import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import axios from "axios";
import { DbClient } from "@orchestrator/db-client";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

export type ServerCandidate = { id: string; url: string };

// How often the active-storage roster is re-read from db-api (and how long a
// pk-seeded placement stays fixed before it rotates). Constants, not config:
// liveness latency is not a per-deployment concern.
const POLL_MS = 15_000;
const TIME_SLOT_MS = 3_600_000;
const RAW_URL = /^(?:https?|wss?):\/\//i;

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export class ServerRegistry {
  private byId = new Map<string, string>();

  constructor(private readonly db: Pick<DbClient, "listActiveStorages">) {}

  async refresh(): Promise<void> {
    try {
      const active = await this.db.listActiveStorages();
      this.byId = new Map(active.map((storage) => [
        storage.npub,
        `http://${hostForUrl(storage.tunnelIp)}:${storage.blossomPort}`,
      ]));
    } catch (error) {
      console.error("Failed to refresh Blossom storage registry; retaining last good state", error);
    }
  }

  candidates(): ServerCandidate[] {
    return [...this.byId].map(([id, url]) => ({ id, url }));
  }

  /**
   * Candidates, re-reading db-api first if the roster is empty. A provider
   * that just came active is served on the next upload rather than after the
   * poll interval; a genuinely empty roster still costs only one read.
   */
  async freshCandidates(): Promise<ServerCandidate[]> {
    if (this.byId.size === 0) {
      await this.refresh();
    }
    return this.candidates();
  }

  resolve(id: string): string | undefined {
    return RAW_URL.test(id) ? id : this.byId.get(id);
  }
}

const registryDb = new DbClient({
  baseUrl: process.env.DB_API_URL ?? `http://localhost:${process.env.DB_API_PORT}`,
  // Signed for consistency with the rest of the proxy's db-api calls.
  // /storages/active is currently ungated (internal network only), so db-api
  // ignores this header — keeping it signed means gating the route later
  // cannot silently break the roster poll.
  ...(process.env.SERVICE_NSEC ? { serviceNsec: process.env.SERVICE_NSEC } : {}),
});
export const serverRegistry = new ServerRegistry(registryDb);
if (process.env.NODE_ENV !== "test") {
  void serverRegistry.refresh();
  setInterval(() => void serverRegistry.refresh(), POLL_MS).unref();
}

// Stable, seedless 64-bit hash (FNV-1a). Placement uses it for even spread;
// only determinism is needed, not cryptographic strength.
function fnv1a(input: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

function byId(a: ServerCandidate, b: ServerCandidate): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Time-bucketed, pk-seeded provider placement. Candidates are npub-sorted so
// the choice never depends on roster poll order, then hash(npub:timeSlot)
// spreads uploads across providers and rotates which provider a busy pubkey
// lands on every TIME_SLOT_MS.
export function selectOwner(
  npub: string,
  candidates: ServerCandidate[],
  now = Date.now(),
): ServerCandidate | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const sorted = [...candidates].sort(byId);
  const timeSlot = Math.floor(now / TIME_SLOT_MS);
  return sorted[Number(fnv1a(`${npub}:${timeSlot}`) % BigInt(sorted.length))];
}

// How many providers hold each blob. A single copy means one offline or
// departed provider loses paying customers' data, so the default is two.
export function replicaTarget(): number {
  const parsed = Math.floor(Number(process.env["BLOSSOM_REPLICAS"]));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 2;
}

// Uploads to the provider selected by hash(npub:timeSlot), then to the next
// pick from the remaining roster, until `replicaCount` providers hold the blob.
// A provider that fails is dropped and the selection recomputed over the rest.
// One copy is enough to succeed (it is logged loudly if fewer than asked for);
// zero copies throws.
export async function uploadBlob(
  blob: Buffer,
  hash: string,
  authHeader: string,
  npub: string,
  registry: Pick<ServerRegistry, "freshCandidates"> = serverRegistry,
  now = Date.now(),
  replicaCount = replicaTarget(),
) {
  const remaining = await registry.freshCandidates();
  if (remaining.length === 0) {
    throw new Error("No storage providers available");
  }

  const tried: string[] = [];
  const stored: string[] = [];
  while (remaining.length > 0 && stored.length < replicaCount) {
    const server = selectOwner(npub, remaining, now)!;
    remaining.splice(remaining.indexOf(server), 1);
    try {
      await axios.put(`${server.url}/upload`, blob, {
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/octet-stream",
          "X-SHA-256": hash,
        },
        timeout: 120_000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      stored.push(server.id);
    } catch (err) {
      console.error(`Failed upload ${server.url}`, err);
      tried.push(server.id);
    }
  }

  if (stored.length === 0) {
    throw new Error(`Failed to upload blob to any storage provider (tried: ${tried.join(", ")})`);
  }
  if (tried.length > 0) {
    console.warn(`Upload for ${npub} skipped failing providers: ${tried.join(", ")}`);
  }
  if (stored.length < replicaCount) {
    console.warn(
      `Blob ${hash} stored on ${stored.length} of ${replicaCount} wanted replicas`,
    );
  }
  return { hash, replicas: stored };
}

export async function downloadBlob(hash: string, replicas: string[]) {
  for (const replica of replicas) {
    const server = serverRegistry.resolve(replica);
    if (!server) {
      console.warn(`Blossom replica ${replica} is not in the active storage registry`);
      continue;
    }
    try {
      const response = await axios.get(`${server}/${hash}`, { responseType: "arraybuffer" });
      return Buffer.from(response.data);
    } catch (err) {
      console.error(`Failed download ${server}`, err);
    }
  }
  throw new Error("Failed to download blob from all replicas");
}

/**
 * Opens the blob as a stream from the first replica that has it, so a large
 * download is piped to the client instead of being held in proxy memory.
 */
export async function openBlobStream(hash: string, replicas: string[]) {
  for (const replica of replicas) {
    const server = serverRegistry.resolve(replica);
    if (!server) {
      console.warn(`Blossom replica ${replica} is not in the active storage registry`);
      continue;
    }
    try {
      const response = await axios.get<Readable>(`${server}/${hash}`, {
        responseType: "stream",
        timeout: 30_000,
      });
      return response.data;
    } catch (err) {
      console.error(`Failed download ${server}`, err);
    }
  }
  throw new Error("Failed to download blob from all replicas");
}

export async function deleteBlob(hash: string, replicas: string[]) {
  for (const replica of replicas) {
    const server = serverRegistry.resolve(replica);
    if (!server) {
      console.warn(`Blossom replica ${replica} is not in the active storage registry`);
      continue;
    }
    try {
      await axios.delete(`${server}/${hash}`);
    } catch (err) {
      console.error(`Failed delete ${server}`, err);
    }
  }
}
