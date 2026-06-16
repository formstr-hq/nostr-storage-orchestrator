import axios from "axios";


export const BLOSSOM_SERVERS = [
  "http://localhost:3000",
];

// export const RELAY_SERVERS = {
//   "http://localhost:8008": true
// };

export async function getServerStatus(url : string) {
  try {
    console.log("Checking", url);
    const [health, storage] = await Promise.all([
      axios.get(`${url}/health`, { timeout: 3000 }),
      axios.get(`${url}/storage`, { timeout: 3000 })
    ]);
    console.log("Health:", health.status);
    console.log("Storage:", storage.data);
    return {
      url,
      healthy: health.status === 200,
      available: storage.data.freeBytes ?? 0
    };
  } catch (e) {
    console.error("Server check failed:", url, e);
    return {
      url,
      healthy: false,
      available: 0
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

export async function uploadBlob(blob: Buffer, authHeader: string, replicaCount: number) {
  const servers = await getBestServers(replicaCount);
  console.log("Selected servers for upload:", servers);
  if (servers.length === 0) {
    throw new Error("No healthy servers available");
  }
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    blob.buffer.slice(
      blob.byteOffset,
      blob.byteOffset + blob.byteLength,
    ) as ArrayBuffer,
  );

  const hexHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const successfulReplicas: string[] = [];

  for (const server of servers) {
    try {
      await axios.post(
        `${server.url}/upload`,
        blob,
        {
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/octet-stream",
            "X-SHA-256": hexHash,
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
    hash: hexHash,
    replicas: successfulReplicas,
  };
}

export async function downloadBlob(hash: string, replicas: string[]) {
  for (const server of replicas) {
    try {
      const response = await axios.get(
        `${server}/download/${hash}`,
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
        `${server}/delete/${hash}`
      );
    } catch (err) {
      console.error(
        `Failed delete ${server}`,
        err
      );
    }
  }
}