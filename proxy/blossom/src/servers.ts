import path from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import { DbClient } from "@orchestrator/db-client";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

export type ServerCandidate = { id: string; url: string };

const FALLBACK_SERVERS = (process.env.BLOSSOM_SERVERS ?? "")
  .split(",")
  .map((url) => url.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const POLL_MS = positiveNumber(process.env.STORAGE_REGISTRY_POLL_MS, 15_000);
// How long a pk-seeded placement stays fixed before it rotates. Defaults to
// one hour; the same bucket is used by every upload within the window.
const TIME_SLOT_MS = positiveNumber(process.env.BLOSSOM_PLACEMENT_SLOT_MS, 3_600_000);
const RAW_URL = /^(?:https?|wss?):\/\//i;

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export class ServerRegistry {
  private byId = new Map<string, string>();
  private warnedFallback = false;

  constructor(
    private readonly db: Pick<DbClient, "listActiveStorages">,
    private readonly fallbackUrls = FALLBACK_SERVERS,
  ) {}

  async refresh(): Promise<void> {
    try {
      const active = await this.db.listActiveStorages();
      if (active.length === 0) {
        this.useFallback();
        return;
      }
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

  resolve(id: string): string | undefined {
    return RAW_URL.test(id) ? id : this.byId.get(id);
  }

  private useFallback(): void {
    this.byId = new Map(this.fallbackUrls.map((url) => [url, url]));
    if (this.fallbackUrls.length > 0 && process.env.NODE_ENV === "production" && !this.warnedFallback) {
      this.warnedFallback = true;
      console.warn("Using BLOSSOM_SERVERS fallback because the DB active storage list is empty");
    }
  }
}

const registryDb = new DbClient({
  baseUrl: process.env.DB_API_URL ?? `http://localhost:${process.env.DB_API_PORT}`,
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

// Uploads to the provider selected by hash(npub:timeSlot). On failure the
// failed provider is dropped and the selection is recomputed over the
// remaining roster, repeating until one provider accepts the blob.
export async function uploadBlob(
  blob: Buffer,
  hash: string,
  authHeader: string,
  npub: string,
  registry: Pick<ServerRegistry, "candidates"> = serverRegistry,
  now = Date.now(),
) {
  const remaining = registry.candidates();
  if (remaining.length === 0) {
    throw new Error("No storage providers available");
  }

  const tried: string[] = [];
  while (remaining.length > 0) {
    const server = selectOwner(npub, remaining, now)!;
    try {
      await axios.put(`${server.url}/upload`, blob, {
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/octet-stream",
          "X-SHA-256": hash,
        },
      });
      if (tried.length > 0) {
        console.warn(`Upload for ${npub} failed over to ${server.id}; tried ${tried.join(", ")}`);
      }
      return { hash, replicas: [server.id] };
    } catch (err) {
      console.error(`Failed upload ${server.url}`, err);
      tried.push(server.id);
      remaining.splice(remaining.indexOf(server), 1);
    }
  }

  throw new Error(`Failed to upload blob to any storage provider (tried: ${tried.join(", ")})`);
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
