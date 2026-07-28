import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, type RawData } from "ws";
import type { NostrEvent } from "nostr-tools";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

type RelaySubscription = {
  subId: string;
  onEvent: (event: NostrEvent) => void;
  onEose: () => void;
  closed: boolean;
};

type RelayConnection = {
  url: string;
  socket: WebSocket;
  pendingOk: Map<string, { resolve: (ok: boolean) => void; reject: (reason?: Error) => void }>;
  subscriptions: Map<string, RelaySubscription>;
};

type RelayMessage = [string, ...unknown[]];

export const RELAYS = (process.env.BACKEND_RELAYS ?? "")
  .split(",")
  .map((relay) => relay.trim())
  .filter(Boolean);

if (RELAYS.length === 0) {
  throw new Error("BACKEND_RELAYS is not configured");
}

export class RelayPool {
  private readonly relays: string[];
  private readonly connections = new Map<string, RelayConnection>();
  private readonly connecting = new Map<string, Promise<RelayConnection>>();

  constructor(relays: string[] = RELAYS) {
    this.relays = relays;
  }

  async publish(event: NostrEvent, targetRelays: string[] = this.relays): Promise<void> {
    await Promise.all(targetRelays.map(async (relay) => {
      const connection = await this.getConnection(relay);
      const okPromise = this.waitForOk(connection, event.id);
      connection.socket.send(JSON.stringify(["EVENT", event]));
      await okPromise;
    }));
  }

  async query(
    filters: Record<string, unknown>[],
    onEvent: (event: NostrEvent) => void,
    onEose: () => void,
    targetRelays: string[] = this.relays,
    onSubRegistered?: (relay: string, backendSubId: string) => void,
  ): Promise<void> {
    await Promise.all(targetRelays.map(async (relay) => {
      const connection = await this.getConnection(relay);
      const subId = createHash("sha256").update(`${relay}:${Date.now()}:${Math.random()}`).digest("hex");
      const subscription: RelaySubscription = {
        subId,
        onEvent,
        onEose,
        closed: false,
      };

      connection.subscriptions.set(subId, subscription);
      connection.socket.send(JSON.stringify(["REQ", subId, ...filters]));
      onSubRegistered?.(relay, subId);

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          connection.subscriptions.delete(subId);
          resolve();
        }, 5000);

        const existing = connection.subscriptions.get(subId);
        if (existing) {
          const forwardEose = existing.onEose;
          existing.onEose = () => {
            clearTimeout(timeout);
            connection.subscriptions.delete(subId);
            forwardEose();
            resolve();
          };
        }
      });
    }));
  }

  closeSubscription(relay: string, backendSubId: string): void {
    const connection = this.connections.get(relay);
    if (!connection) {
      return;
    }
    const subscription = connection.subscriptions.get(backendSubId);
    if (subscription) {
      subscription.closed = true;
      connection.subscriptions.delete(backendSubId);
    }
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify(["CLOSE", backendSubId]));
    }
  }

  async delete(event: NostrEvent, targetRelays: string[] = this.relays): Promise<void> {
    await this.publish(event, targetRelays);
  }

  async health(): Promise<Array<{ relay: string; healthy: boolean }>> {
    return Promise.all(this.relays.map(async (relay) => {
      try {
        const connection = await this.getConnection(relay);
        return { relay, healthy: connection.socket.readyState === WebSocket.OPEN };
      } catch {
        return { relay, healthy: false };
      }
    }));
  }

  async selectHealthyRelays(count: number): Promise<string[]> {
    const healthy = (await this.health())
      .filter((entry) => entry.healthy)
      .map((entry) => entry.relay);

    if (healthy.length < count) {
      throw new Error(`Insufficient healthy relays: expected ${count}, found ${healthy.length}`);
    }

    return healthy.slice(0, count);
  }

  private async getConnection(relay: string): Promise<RelayConnection> {
    const existing = this.connections.get(relay);
    if (existing?.socket.readyState === WebSocket.OPEN) {
      return existing;
    }

    const pending = this.connecting.get(relay);
    if (pending) {
      return pending;
    }

    const connectionPromise = new Promise<RelayConnection>((resolve, reject) => {
      const socket = new WebSocket(relay);
      const connection: RelayConnection = {
        url: relay,
        socket,
        pendingOk: new Map(),
        subscriptions: new Map(),
      };

      const cleanup = () => {
        this.connections.delete(relay);
        this.connecting.delete(relay);
      };

      socket.on("open", () => {
        this.connections.set(relay, connection);
        this.connecting.delete(relay);
        resolve(connection);
      });

      socket.on("error", (error) => {
        cleanup();
        reject(error);
      });

      socket.on("close", () => {
        cleanup();
        for (const pendingEntry of connection.pendingOk.values()) {
          pendingEntry.reject(new Error("Relay closed"));
        }
        connection.pendingOk.clear();
      });

      socket.on("message", (raw: RawData) => {
        const payload = this.parseMessage(raw);
        if (!Array.isArray(payload)) {
          return;
        }

        const [messageType, ...rest] = payload as RelayMessage;
        if (messageType === "OK") {
          const eventId = rest[0];
          const ok = rest[1];
          if (typeof eventId === "string") {
            const pending = connection.pendingOk.get(eventId);
            if (pending) {
              connection.pendingOk.delete(eventId);
              pending.resolve(ok === true);
            }
          }
          return;
        }

        if (messageType === "EOSE") {
          const subId = rest[0];
          if (typeof subId === "string") {
            const subscription = connection.subscriptions.get(subId);
            if (subscription) {
              subscription.closed = true;
              connection.subscriptions.delete(subId);
              subscription.onEose();
            }
          }
          return;
        }

        if (messageType === "EVENT") {
          const subId = rest[0];
          const event = rest[1];
          if (typeof subId === "string" && event && typeof event === "object") {
            const subscription = connection.subscriptions.get(subId);
            if (subscription && !subscription.closed) {
              subscription.onEvent(event as NostrEvent);
            }
          }
        }
      });
    });

    this.connecting.set(relay, connectionPromise);
    return connectionPromise;
  }

  private waitForOk(connection: RelayConnection, eventId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        connection.pendingOk.delete(eventId);
        reject(new Error("Timed out waiting for backend OK"));
      }, 5000);

      connection.pendingOk.set(eventId, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (reason?: Error) => {
          clearTimeout(timeout);
          reject(reason ?? new Error("Backend rejected event"));
        },
      });
    });
  }

  private parseMessage(raw: RawData): unknown {
    const payload = typeof raw === "string" ? raw : raw.toString();
    return JSON.parse(payload);
  }
}