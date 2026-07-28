import { createHash } from "node:crypto";
import { finalizeEvent, type EventTemplate } from "nostr-tools/pure";
import { WebSocket, type RawData } from "ws";
import type { NostrEvent } from "nostr-tools";
import { normalizeReason } from "./protocol.js";

export type BackendSubStatus = "pending" | "eose" | "timed-out" | "failed" | "closed";

export type PublishResult = {
  relay: string;
  accepted: boolean;
  message: string;
};

export type BackendSubscriptionRef = {
  relay: string;
  backendSubId: string;
  status: BackendSubStatus;
  reason?: string;
};

export type RelayLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};

export type RelayPoolOptions = {
  relays?: string[];
  initialEoseTimeoutMs?: number;
  publishAckTimeoutMs?: number;
  connectTimeoutMs?: number;
  backendAuthProbeMs?: number;
  wsFactory?: (url: string) => WebSocket;
  logger?: RelayLogger;
  backendAuthSecretKey?: Uint8Array;
};

type RelayMessage = [string, ...unknown[]];

type PendingOk = {
  resolve: (result: { accepted: boolean; message: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type BackendSubscription = {
  backendSubId: string;
  relay: string;
  generation: number;
  initialStatus: BackendSubStatus;
  initialReason?: string;
  initialSettled: boolean;
  closed: boolean;
  onEvent: (event: NostrEvent) => void;
  onInitialSettled: (status: BackendSubStatus, reason?: string) => void;
  onBackendClosed: (reason: string) => void;
  eoseTimer?: ReturnType<typeof setTimeout>;
};

type RelayConnection = {
  url: string;
  socket: WebSocket;
  pendingOk: Map<string, PendingOk>;
  subscriptions: Map<string, BackendSubscription>;
  authUnavailable: boolean;
  authUnavailableReason?: string;
};

type SubscriptionCallbacks = {
  onEvent: (event: NostrEvent, relay: string) => void;
  onBackendInitialSettled: (relay: string, backendSubId: string, status: BackendSubStatus, reason?: string) => void;
  onBackendClosed: (relay: string, backendSubId: string, reason: string) => void;
};

export type SubscriptionHandle = {
  generation: number;
  backendSubs: BackendSubscriptionRef[];
  initialSync: Promise<void>;
  close: () => void;
  suppress: () => void;
  getBackendStatuses: () => BackendSubscriptionRef[];
};

const defaultLogger: RelayLogger = {};

export class RelayPool {
  private readonly relays: string[];
  private readonly initialEoseTimeoutMs: number;
  private readonly publishAckTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly backendAuthProbeMs: number;
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly logger: RelayLogger;
  private readonly backendAuthSecretKey?: Uint8Array;
  private readonly connections = new Map<string, RelayConnection>();
  private readonly connecting = new Map<string, Promise<RelayConnection>>();

  constructor(options: RelayPoolOptions = {}) {
    this.relays = options.relays ?? [];
    this.initialEoseTimeoutMs = options.initialEoseTimeoutMs ?? 5000;
    this.publishAckTimeoutMs = options.publishAckTimeoutMs ?? 5000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.backendAuthProbeMs = options.backendAuthProbeMs ?? 25;
    this.wsFactory = options.wsFactory ?? ((url) => new WebSocket(url));
    this.logger = options.logger ?? defaultLogger;
    if (options.backendAuthSecretKey) {
      this.backendAuthSecretKey = options.backendAuthSecretKey;
    }
  }

  async publish(event: NostrEvent, targetRelays: string[] = this.relays): Promise<PublishResult[]> {
    const settled = await Promise.allSettled(
      targetRelays.map(async (relay): Promise<PublishResult> => {
        try {
          const connection = await this.getConnection(relay);
          if (connection.authUnavailable) {
            return {
              relay,
              accepted: false,
              message: connection.authUnavailableReason ?? "auth-required: backend relay requires authentication",
            };
          }
          const ack = this.waitForOk(connection, event.id);
          connection.socket.send(JSON.stringify(["EVENT", event]));
          const result = await ack;
          return { relay, accepted: result.accepted, message: result.message };
        } catch (error) {
          return {
            relay,
            accepted: false,
            message: normalizeReason(error instanceof Error ? error.message : "publish failed"),
          };
        }
      }),
    );

    return settled.map((entry, index) => {
      const relay = targetRelays[index] ?? "unknown";
      if (entry.status === "fulfilled") {
        return entry.value;
      }
      return {
        relay,
        accepted: false,
        message: normalizeReason(entry.reason instanceof Error ? entry.reason.message : "publish failed"),
      };
    });
  }

  subscribe(
    filters: Record<string, unknown>[],
    callbacks: SubscriptionCallbacks,
    options: {
      targetRelays?: string[];
      generation?: number;
      signal?: AbortSignal;
    } = {},
  ): SubscriptionHandle {
    const generation = options.generation ?? 0;
    const targetRelays = options.targetRelays ?? this.relays;
    const backendRefs: BackendSubscriptionRef[] = [];
    let suppressed = false;
    let closed = false;

    const handle: SubscriptionHandle = {
      generation,
      backendSubs: backendRefs,
      initialSync: Promise.resolve(),
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        this.closeHandle(handle);
      },
      suppress: () => {
        suppressed = true;
      },
      getBackendStatuses: () => backendRefs.map((entry) => ({ ...entry })),
    };

    const onAbort = () => {
      handle.close();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        suppressed = true;
        closed = true;
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    handle.initialSync = Promise.allSettled(
      targetRelays.map(async (relay) => {
        const backendSubId = createHash("sha256")
          .update(`${relay}:${Date.now()}:${Math.random()}`)
          .digest("hex");

        const ref: BackendSubscriptionRef = {
          relay,
          backendSubId,
          status: "pending",
        };
        backendRefs.push(ref);

        if (closed || suppressed || options.signal?.aborted) {
          ref.status = "closed";
          return;
        }

        try {
          const connection = await this.getConnection(relay);
          if (connection.authUnavailable) {
            const authReason =
              connection.authUnavailableReason ?? "auth-required: backend relay requires authentication";
            ref.status = "failed";
            ref.reason = authReason;
            callbacks.onBackendInitialSettled(relay, backendSubId, "failed", authReason);
            return;
          }

          const subscription: BackendSubscription = {
            backendSubId,
            relay,
            generation,
            initialStatus: "pending",
            initialSettled: false,
            closed: false,
            onEvent: (event) => {
              if (suppressed || closed || subscription.generation !== generation) {
                return;
              }
              callbacks.onEvent(event, relay);
            },
            onInitialSettled: (status, reason) => {
              if (subscription.initialSettled) {
                return;
              }
              subscription.initialSettled = true;
              ref.status = status;
              if (reason) {
                ref.reason = reason;
              }
              callbacks.onBackendInitialSettled(relay, backendSubId, status, reason);
            },
            onBackendClosed: (reason) => {
              subscription.closed = true;
              ref.status = "closed";
              ref.reason = reason;
              callbacks.onBackendClosed(relay, backendSubId, reason);
            },
          };

          subscription.eoseTimer = setTimeout(() => {
            if (!subscription.initialSettled) {
              subscription.initialStatus = "timed-out";
              subscription.onInitialSettled("timed-out", "error: initial query timed out");
            }
          }, this.initialEoseTimeoutMs);

          connection.subscriptions.set(backendSubId, subscription);
          connection.socket.send(JSON.stringify(["REQ", backendSubId, ...filters]));
        } catch (error) {
          ref.status = "failed";
          ref.reason = normalizeReason(error instanceof Error ? error.message : "connection failed");
          callbacks.onBackendInitialSettled(relay, backendSubId, "failed", ref.reason);
        }
      }),
    ).then(() => undefined);

    return handle;
  }

  closeSubscription(relay: string, backendSubId: string): void {
    const connection = this.connections.get(relay);
    if (!connection) {
      return;
    }
    const subscription = connection.subscriptions.get(backendSubId);
    if (!subscription || subscription.closed) {
      return;
    }
    subscription.closed = true;
    if (subscription.eoseTimer) {
      clearTimeout(subscription.eoseTimer);
    }
    connection.subscriptions.delete(backendSubId);
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify(["CLOSE", backendSubId]));
    }
  }

  async delete(event: NostrEvent, targetRelays: string[] = this.relays): Promise<PublishResult[]> {
    return this.publish(event, targetRelays);
  }

  async health(): Promise<Array<{ relay: string; healthy: boolean }>> {
    if (this.relays.length === 0) {
      return [];
    }
    return Promise.all(
      this.relays.map(async (relay) => {
        try {
          const connection = await this.getConnection(relay);
          return { relay, healthy: connection.socket.readyState === WebSocket.OPEN && !connection.authUnavailable };
        } catch {
          return { relay, healthy: false };
        }
      }),
    );
  }

  async selectHealthyRelays(count: number): Promise<string[]> {
    const healthy = (await this.health())
      .filter((entry) => entry.healthy)
      .map((entry) => entry.relay);

    if (healthy.length < count) {
      throw new Error(`error: insufficient healthy relays: expected ${count}, found ${healthy.length}`);
    }

    return healthy.slice(0, count);
  }

  closeAll(): void {
    for (const connection of this.connections.values()) {
      for (const subscription of connection.subscriptions.values()) {
        if (subscription.eoseTimer) {
          clearTimeout(subscription.eoseTimer);
        }
      }
      connection.subscriptions.clear();
      for (const pending of connection.pendingOk.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("error: relay pool closed"));
      }
      connection.pendingOk.clear();
      connection.socket.terminate();
    }
    this.connections.clear();
    this.connecting.clear();
  }

  private closeHandle(handle: SubscriptionHandle): void {
    for (const backendSub of handle.backendSubs) {
      if (backendSub.status !== "closed" && backendSub.status !== "failed") {
        this.closeSubscription(backendSub.relay, backendSub.backendSubId);
        backendSub.status = "closed";
      }
    }
  }

  private async getConnection(relay: string): Promise<RelayConnection> {
    const existing = this.connections.get(relay);
    if (existing?.socket.readyState === WebSocket.OPEN) {
      if (existing.authUnavailable) {
        throw new Error(existing.authUnavailableReason ?? "auth-required: backend relay requires authentication");
      }
      return existing;
    }
    if (existing) {
      this.connections.delete(relay);
    }

    const pending = this.connecting.get(relay);
    if (pending) {
      return pending;
    }

    const connectionPromise = new Promise<RelayConnection>((resolve, reject) => {
      const socket = this.wsFactory(relay);
      const connection: RelayConnection = {
        url: relay,
        socket,
        pendingOk: new Map(),
        subscriptions: new Map(),
        authUnavailable: false,
      };
      let readySettled = false;
      let authProbeTimer: ReturnType<typeof setTimeout> | undefined;

      const resolveReady = () => {
        if (readySettled) {
          return;
        }
        readySettled = true;
        clearTimeout(connectTimeout);
        if (authProbeTimer) {
          clearTimeout(authProbeTimer);
        }
        this.connections.set(relay, connection);
        this.connecting.delete(relay);
        resolve(connection);
      };

      const rejectReady = (error: Error) => {
        if (readySettled) {
          return;
        }
        readySettled = true;
        clearTimeout(connectTimeout);
        if (authProbeTimer) {
          clearTimeout(authProbeTimer);
        }
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        this.connections.delete(relay);
        this.connecting.delete(relay);
      };

      const failConnection = (reason: string) => {
        connection.authUnavailable = true;
        connection.authUnavailableReason = normalizeReason(reason, "auth-required:");
        rejectReady(new Error(connection.authUnavailableReason));
        for (const pendingEntry of connection.pendingOk.values()) {
          clearTimeout(pendingEntry.timeout);
          pendingEntry.reject(new Error(connection.authUnavailableReason!));
        }
        connection.pendingOk.clear();
        for (const subscription of connection.subscriptions.values()) {
          if (subscription.eoseTimer) {
            clearTimeout(subscription.eoseTimer);
          }
          subscription.onBackendClosed(connection.authUnavailableReason!);
        }
        connection.subscriptions.clear();
      };

      const connectTimeout = setTimeout(() => {
        socket.terminate();
        rejectReady(new Error(`error: timed out connecting to backend relay ${relay}`));
      }, this.connectTimeoutMs);

      socket.on("open", () => {
        // NIP-42 challenges arrive immediately after connection. Hold outbound
        // operations briefly so an authentication-required backend can
        // challenge and complete AUTH before the first REQ/EVENT is sent.
        authProbeTimer = setTimeout(resolveReady, this.backendAuthProbeMs);
      });

      socket.on("error", (error) => {
        rejectReady(error);
      });

      socket.on("close", () => {
        clearTimeout(connectTimeout);
        cleanup();
        for (const pendingEntry of connection.pendingOk.values()) {
          clearTimeout(pendingEntry.timeout);
          pendingEntry.reject(new Error("error: backend relay connection closed"));
        }
        connection.pendingOk.clear();
        for (const subscription of [...connection.subscriptions.values()]) {
          if (subscription.eoseTimer) {
            clearTimeout(subscription.eoseTimer);
          }
          if (!subscription.initialSettled) {
            subscription.onInitialSettled("failed", "error: backend relay connection closed");
          }
          subscription.onBackendClosed("error: backend relay connection closed");
        }
        connection.subscriptions.clear();
      });

      socket.on("message", (raw: RawData) => {
        this.handleBackendMessage(connection, raw, failConnection, () => {
          if (authProbeTimer) {
            clearTimeout(authProbeTimer);
          }
        }, resolveReady);
      });
    });

    this.connecting.set(relay, connectionPromise);
    return connectionPromise;
  }

  private handleBackendMessage(
    connection: RelayConnection,
    raw: RawData,
    failConnection: (reason: string) => void,
    onAuthChallenge: () => void,
    onAuthReady: () => void,
  ): void {
    let payload: unknown;
    try {
      payload = this.parseMessage(raw);
    } catch {
      this.logger.warn?.("invalid backend JSON", { relay: connection.url });
      return;
    }
    if (!Array.isArray(payload)) {
      return;
    }

    const [messageType, ...rest] = payload as RelayMessage;

    if (messageType === "AUTH") {
      onAuthChallenge();
      const challenge = rest[0];
      if (typeof challenge !== "string") {
        return;
      }
      if (this.backendAuthSecretKey) {
        const authEvent = finalizeEvent(
          {
            kind: 22242,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["relay", connection.url],
              ["challenge", challenge],
            ],
            content: "",
          } satisfies EventTemplate,
          this.backendAuthSecretKey,
        );
        const authAcknowledgement = this.waitForOk(connection, authEvent.id);
        connection.socket.send(JSON.stringify(["AUTH", authEvent]));
        void authAcknowledgement.then(onAuthReady).catch((error: unknown) => {
          failConnection(error instanceof Error ? error.message : "auth-required: backend authentication failed");
        });
      } else {
        failConnection("auth-required: backend relay requires authentication");
      }
      return;
    }

    if (messageType === "OK") {
      const eventId = rest[0];
      const ok = rest[1];
      const reason = typeof rest[2] === "string" ? rest[2] : "";
      if (typeof eventId === "string") {
        const pending = connection.pendingOk.get(eventId);
        if (pending) {
          connection.pendingOk.delete(eventId);
          clearTimeout(pending.timeout);
          pending.resolve({
            accepted: ok === true,
            message: ok === true ? "" : normalizeReason(reason || "blocked: event rejected", "blocked:"),
          });
        }
      }
      return;
    }

    if (messageType === "NOTICE") {
      const notice = typeof rest[0] === "string" ? rest[0] : "backend notice";
      this.logger.info?.("backend notice", { relay: connection.url, notice });
      return;
    }

    if (messageType === "EOSE") {
      const subId = rest[0];
      if (typeof subId !== "string") {
        return;
      }
      const subscription = connection.subscriptions.get(subId);
      if (!subscription || subscription.closed) {
        return;
      }
      if (subscription.eoseTimer) {
        clearTimeout(subscription.eoseTimer);
      }
      if (!subscription.initialSettled) {
        subscription.initialStatus = "eose";
        subscription.onInitialSettled("eose");
      }
      return;
    }

    if (messageType === "CLOSED") {
      const subId = rest[0];
      const reason = typeof rest[1] === "string" ? rest[1] : "error: backend subscription closed";
      if (typeof subId !== "string") {
        return;
      }
      const subscription = connection.subscriptions.get(subId);
      if (!subscription) {
        return;
      }
      if (subscription.eoseTimer) {
        clearTimeout(subscription.eoseTimer);
      }
      connection.subscriptions.delete(subId);
      subscription.closed = true;
      if (!subscription.initialSettled) {
        subscription.onInitialSettled("closed", normalizeReason(reason));
      }
      subscription.onBackendClosed(normalizeReason(reason));
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
  }

  private waitForOk(connection: RelayConnection, eventId: string): Promise<{ accepted: boolean; message: string }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        connection.pendingOk.delete(eventId);
        reject(new Error("error: timed out waiting for backend OK"));
      }, this.publishAckTimeoutMs);

      connection.pendingOk.set(eventId, {
        timeout,
        resolve: (result) => {
          clearTimeout(timeout);
          if (result.accepted) {
            resolve(result);
          } else {
            reject(new Error(result.message || "blocked: event rejected"));
          }
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  private parseMessage(raw: RawData): unknown {
    const payload = typeof raw === "string" ? raw : raw.toString();
    return JSON.parse(payload);
  }
}
