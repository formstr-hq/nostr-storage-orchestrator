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

export async function getServerStatus(url: string) {
  try {
    const health = await axios.get(`${url}/health`, { timeout: 3000 });
    return {
      url,
      healthy: health.status === 200,
      available: Number.MAX_SAFE_INTEGER,
    };
  } catch (e) {
    console.error("Server check failed:", url, e);
    return {
      url,
      healthy: false,
      available: 0,
    };
  }
}

export async function getBestServers(replicaCount: number) {
  const statuses = await Promise.all(serverRegistry.candidates().map(async (candidate) => ({
    ...await getServerStatus(candidate.url),
    id: candidate.id,
  })));

  return statuses
    .filter((server) => server.healthy)
    .sort((a, b) => b.available - a.available)
    .slice(0, replicaCount);
}

export async function uploadBlob(blob: Buffer, hash: string, authHeader: string, replicaCount: number) {
  const servers = await getBestServers(replicaCount);
  console.log("Selected servers for upload:", servers);
  if (servers.length === 0) {
    throw new Error("No healthy servers available");
  }

  const successfulReplicas: string[] = [];
  for (const server of servers) {
    try {
      await axios.put(`${server.url}/upload`, blob, {
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/octet-stream",
          "X-SHA-256": hash,
        },
      });
      successfulReplicas.push(server.id);
    } catch (err) {
      console.error(`Failed upload ${server.url}`, err);
    }
  }

  if (successfulReplicas.length < replicaCount) {
    throw new Error("Failed to satisfy replica count");
  }
  return { hash, replicas: successfulReplicas };
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
