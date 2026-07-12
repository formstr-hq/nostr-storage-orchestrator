import path from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

export const BLOSSOM_SERVERS =
  process.env.BLOSSOM_SERVERS?.split(",")
    .map(url => url.trim())
    .filter(Boolean) ?? [];

if (BLOSSOM_SERVERS.length === 0) {
  throw new Error("BLOSSOM_SERVERS is not configured");
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
  const statuses = await Promise.all(
    BLOSSOM_SERVERS.map(getServerStatus)
  );

  return statuses
    .filter(s => s.healthy)
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
      await axios.put(
        `${server.url}/upload`,
        blob,
        {
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/octet-stream",
            "X-SHA-256": hash,
          },
        }
      );

      successfulReplicas.push(server.url);
    } catch (err) {
      console.error(
        `Failed upload ${server.url}`,
        err
      );
    }
  }

  if (successfulReplicas.length < replicaCount) {
    throw new Error(
      "Failed to satisfy replica count"
    );
  }

  return {
    hash,
    replicas: successfulReplicas,
  };
}

export async function downloadBlob(hash: string, replicas: string[]) {
  for (const server of replicas) {
    try {
      const response = await axios.get(
        `${server}/${hash}`,
        { responseType: "arraybuffer" }
      );
      return Buffer.from(response.data);
    } catch (err) {
      console.error(
        `Failed download ${server}`,
        err
      );
    }
  }

  throw new Error("Failed to download blob from all replicas");
}

export async function deleteBlob(hash: string, replicas: string[]) {
  for (const server of replicas) {
    try {
      await axios.delete(
        `${server}/${hash}`
      );
    } catch (err) {
      console.error(
        `Failed delete ${server}`,
        err
      );
    }
  }
}