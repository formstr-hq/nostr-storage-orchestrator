import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { NostrEvent } from "nostr-tools";

export type FakeBackendOptions = {
  authChallenge?: boolean;
  requireAuth?: boolean;
  autoOk?: boolean;
  autoEose?: boolean;
  eoseDelayMs?: number;
  okResponses?: Record<string, { accepted: boolean; reason?: string }>;
};

export type FakeBackend = {
  url: string;
  server: Server;
  wss: WebSocketServer;
  subscriptions: Map<string, { filters: Record<string, unknown>[] }>;
  readonly connectionCount: number;
  sent: unknown[][];
  okResponses: Record<string, { accepted: boolean; reason?: string }>;
  close: () => Promise<void>;
  sendEvent: (backendSubId: string, event: NostrEvent) => void;
  sendEose: (backendSubId: string) => void;
  sendClosed: (backendSubId: string, reason: string) => void;
  closeSocket: () => void;
};

export async function startFakeBackend(options: FakeBackendOptions = {}): Promise<FakeBackend> {
  const subscriptions = new Map<string, { filters: Record<string, unknown>[] }>();
  const subscriptionOwners = new Map<string, WebSocket>();
  let connectionCount = 0;
  const sent: unknown[][] = [];
  const okResponses: Record<string, { accepted: boolean; reason?: string }> = {
    ...(options.okResponses ?? {}),
  };
  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket) => {
    connectionCount += 1;
    let authenticated = !options.requireAuth;
    if (options.authChallenge) {
      socket.send(JSON.stringify(["AUTH", "backend-challenge"]));
    }

    socket.on("message", (raw) => {
      const payload = JSON.parse(raw.toString()) as unknown[];
      sent.push(payload);
      const [type, ...rest] = payload;
      if (type === "AUTH") {
        const event = rest[0] as NostrEvent;
        authenticated = true;
        socket.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }
      if (type === "REQ") {
        const [subId, ...filters] = rest as [string, ...Record<string, unknown>[]];
        if (!authenticated) {
          socket.send(JSON.stringify(["CLOSED", subId, "auth-required: authenticate first"]));
          return;
        }
        subscriptions.set(subId, { filters });
        subscriptionOwners.set(subId, socket);
        if (options.autoEose !== false) {
          const delay = options.eoseDelayMs ?? 0;
          setTimeout(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(["EOSE", subId]));
            }
          }, delay);
        }
      }
      if (type === "EVENT") {
        const event = rest[0] as NostrEvent;
        if (!authenticated) {
          socket.send(JSON.stringify(["OK", event.id, false, "auth-required: authenticate first"]));
          return;
        }
        const response = okResponses[event.id];
        if (response) {
          socket.send(
            JSON.stringify([
              "OK",
              event.id,
              response.accepted,
              response.reason ?? (response.accepted ? "" : "blocked: event rejected"),
            ]),
          );
        } else if (options.autoOk !== false) {
          socket.send(JSON.stringify(["OK", event.id, true, ""]));
        }
      }
      if (type === "CLOSE") {
        const [subId] = rest as [string];
        subscriptions.delete(subId);
        subscriptionOwners.delete(subId);
      }
    });

    socket.on("close", () => {
      for (const [subId, owner] of subscriptionOwners) {
        if (owner === socket) {
          subscriptionOwners.delete(subId);
          subscriptions.delete(subId);
        }
      }
    });
  });

  const url = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind fake backend"));
        return;
      }
      resolve(`ws://127.0.0.1:${address.port}`);
    });
  });

  const getSocket = (): WebSocket | undefined => {
    for (const client of wss.clients) {
      return client;
    }
    return undefined;
  };

  return {
    url,
    server,
    wss,
    subscriptions,
    get connectionCount() {
      return connectionCount;
    },
    sent,
    okResponses,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close((wssError) => {
          if (wssError) {
            reject(wssError);
            return;
          }
          server.close((serverError) => {
            if (serverError) {
              reject(serverError);
              return;
            }
            resolve();
          });
        });
      }),
    sendEvent: (backendSubId, event) => {
      const socket = getSocket();
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(["EVENT", backendSubId, event]));
      }
    },
    sendEose: (backendSubId) => {
      const socket = getSocket();
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(["EOSE", backendSubId]));
      }
    },
    sendClosed: (backendSubId, reason) => {
      const socket = getSocket();
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(["CLOSED", backendSubId, reason]));
      }
    },
    closeSocket: () => {
      for (const client of wss.clients) {
        client.close();
      }
    },
  };
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RelayMessage = unknown[];

export class RelayTestClient {
  private readonly ws: WebSocket;
  private readonly queue: RelayMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: RelayMessage) => boolean;
    resolve: (message: RelayMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as RelayMessage;
      const index = this.waiters.findIndex((entry) => entry.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter!.timer);
        waiter!.resolve(message);
      } else {
        this.queue.push(message);
      }
    });
  }

  async connected(timeoutMs = 5000): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("websocket open timeout")), timeoutMs);
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  send(payload: RelayMessage): void {
    this.ws.send(JSON.stringify(payload));
  }

  async waitFor(predicate: (message: RelayMessage) => boolean, timeoutMs = 5000): Promise<RelayMessage> {
    const queuedIndex = this.queue.findIndex(predicate);
    if (queuedIndex >= 0) {
      const [message] = this.queue.splice(queuedIndex, 1);
      return message!;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((entry) => entry.resolve === resolve);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error("timed out waiting for relay message"));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  drain(predicate: (message: RelayMessage) => boolean, timeoutMs = 200): Promise<RelayMessage[]> {
    const collected: RelayMessage[] = [];
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const poll = () => {
        while (true) {
          const index = this.queue.findIndex(predicate);
          if (index < 0) {
            break;
          }
          collected.push(this.queue.splice(index, 1)[0]!);
        }
        if (Date.now() >= deadline) {
          resolve(collected);
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
  }

  close(): void {
    this.ws.close();
  }
}
