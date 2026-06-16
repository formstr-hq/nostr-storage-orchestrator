import axios from "axios";
import { type Event } from "nostr-tools";

export const RELAYS = [
    "http://localhost:8008",
];

export async function getServerStatus(url : string) {
  try {
    const [health, storage] = await Promise.all([
      axios.get(`${url}/health`, { timeout: 3000 }),
      axios.get(`${url}/storage`, { timeout: 3000 })
    ]);

    return {
      url,
      healthy: health.status === 200,
      available: storage.data.freeBytes ?? 0
    };
  } catch {
    return {
      url,
      healthy: false,
      available: 0
    };
  }
}

export async function getBestServers(replication = 3) {
  const statuses = await Promise.all(
    RELAYS.map(getServerStatus)
  );

  return statuses
    .filter(s => s.healthy)
    .sort((a, b) => b.available - a.available)
    .slice(0, replication);
}

export async function uploadEvent(event: Event, authHeader: string) {
  const servers = await getBestServers();

  if (servers.length === 0) {
    throw new Error("No healthy servers available");
  }

  const server = servers[0];

  const response = await axios.post(
    `${server!.url}/upload`,
    event,
    {
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader
      }
    }
  );

  return response.data;
}