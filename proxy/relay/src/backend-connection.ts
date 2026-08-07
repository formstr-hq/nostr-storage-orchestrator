import { WebSocket } from "ws";
import { BackendMessageHandler } from "./backend-message-handler.js";
import { BackendSubscriptionRegistry } from "./backend-subscription-registry.js";
import { normalizeReason } from "./protocol.js";
import { ReconnectScheduler } from "./reconnect-scheduler.js";
import type {
  BackendSubscription,
  RelayConnection,
  RelayLogger,
  RelayPoolOptions,
} from "./relay-types.js";

const defaultLogger: RelayLogger = {};

export class BackendConnectionManager {
  private readonly publishAckTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly backendAuthProbeMs: number;
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly logger: RelayLogger;
  private readonly messageHandler: BackendMessageHandler;
  private readonly reconnectScheduler: ReconnectScheduler;
  private readonly connections = new Map<string, RelayConnection>();
  private readonly connecting = new Map<string, Promise<RelayConnection>>();
  private readonly sockets = new Map<string, WebSocket>();
  private readonly subscriptionRegistry = new BackendSubscriptionRegistry();
  private readonly authFailures = new Map<string, string>();
  private stopped = false;

  constructor(options: RelayPoolOptions) {
    this.publishAckTimeoutMs = options.publishAckTimeoutMs ?? 5000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.backendAuthProbeMs = options.backendAuthProbeMs ?? 25;
    this.wsFactory = options.wsFactory ?? ((url) => new WebSocket(url));
    this.logger = options.logger ?? defaultLogger;
    this.reconnectScheduler = new ReconnectScheduler(options, this.logger);
    this.messageHandler = new BackendMessageHandler(
      this.logger,
      options.backendAuthSecretKey,
      (connection, eventId) => this.waitForOk(connection, eventId),
    );
  }

  async get(relay: string): Promise<RelayConnection> {
    if (this.stopped) {
      throw new Error("error: relay pool closed");
    }
    const authFailure = this.authFailures.get(relay);
    if (authFailure) {
      throw new Error(authFailure);
    }

    const existing = this.connections.get(relay);
    if (existing?.socket.readyState === WebSocket.OPEN) {
      return existing;
    }
    if (existing) {
      this.connections.delete(relay);
    }

    const pending = this.connecting.get(relay);
    if (pending) {
      return pending;
    }
    if (this.reconnectScheduler.isScheduled(relay)) {
      throw new Error("error: backend relay reconnect pending");
    }
    return this.startConnection(relay);
  }

  async openSubscription(subscription: BackendSubscription): Promise<void> {
    this.subscriptionRegistry.register(subscription);

    const connection = await this.get(subscription.relay);
    if (this.subscriptionRegistry.has(subscription) && !subscription.closed) {
      this.attachSubscription(connection, subscription);
    }
  }

  waitForOk(connection: RelayConnection, eventId: string): Promise<{ accepted: boolean; message: string }> {
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

  closeSubscription(relay: string, backendSubId: string): void {
    this.subscriptionRegistry.close(relay, backendSubId);

    const connection = this.connections.get(relay);
    connection?.subscriptions.delete(backendSubId);
    if (connection?.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify(["CLOSE", backendSubId]));
    }
  }

  closeAll(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    this.reconnectScheduler.stop();

    this.subscriptionRegistry.closeAll();

    for (const connection of this.connections.values()) {
      this.rejectPendingPublications(connection, "error: relay pool closed");
      connection.subscriptions.clear();
    }
    for (const socket of this.sockets.values()) {
      socket.terminate();
    }
    this.sockets.clear();
    this.connections.clear();
    this.connecting.clear();
  }

  private startConnection(relay: string): Promise<RelayConnection> {
    const connectionPromise = this.connect(relay);
    this.connecting.set(relay, connectionPromise);
    void connectionPromise.then(
      () => {
        if (this.connecting.get(relay) === connectionPromise) {
          this.connecting.delete(relay);
        }
        this.reconnectScheduler.reset(relay);
        this.logger.info?.("backend relay connected", { relay });
      },
      (error: unknown) => {
        if (this.connecting.get(relay) === connectionPromise) {
          this.connecting.delete(relay);
        }
        const reason = error instanceof Error ? error.message : "error: backend connection failed";
        this.logger.warn?.("backend relay connection failed", { relay, reason });
        this.scheduleReconnect(relay, reason);
      },
    );
    return connectionPromise;
  }

  private connect(relay: string): Promise<RelayConnection> {
    return new Promise<RelayConnection>((resolve, reject) => {
      const socket = this.wsFactory(relay);
      this.sockets.set(relay, socket);
      const connection: RelayConnection = {
        url: relay,
        socket,
        pendingOk: new Map(),
        subscriptions: new Map(),
        authUnavailable: false,
      };
      let readySettled = false;
      let wasReady = false;
      let authProbeTimer: ReturnType<typeof setTimeout> | undefined;

      const resolveReady = () => {
        if (readySettled) {
          return;
        }
        if (this.stopped) {
          rejectReady(new Error("error: relay pool closed"));
          socket.terminate();
          return;
        }
        try {
          this.restoreSubscriptions(connection);
        } catch (error) {
          rejectReady(error instanceof Error ? error : new Error("error: failed to restore subscriptions"));
          socket.terminate();
          return;
        }
        readySettled = true;
        wasReady = true;
        clearTimeout(connectTimeout);
        if (authProbeTimer) {
          clearTimeout(authProbeTimer);
        }
        this.connections.set(relay, connection);
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
        reject(error);
      };
      const failConnection = (reason: string) => {
        const authReason = normalizeReason(reason, "auth-required:");
        connection.authUnavailable = true;
        connection.authUnavailableReason = authReason;
        this.authFailures.set(relay, authReason);
        rejectReady(new Error(authReason));
        this.rejectPendingPublications(connection, authReason);
        this.subscriptionRegistry.fail(relay, authReason);
        socket.terminate();
      };

      const connectTimeout = setTimeout(() => {
        rejectReady(new Error(`error: timed out connecting to backend relay ${relay}`));
        socket.terminate();
      }, this.connectTimeoutMs);

      socket.on("open", () => {
        // Give an authentication-required backend time to issue its NIP-42 challenge.
        authProbeTimer = setTimeout(resolveReady, this.backendAuthProbeMs);
      });
      socket.on("error", (error) => {
        if (!wasReady) {
          rejectReady(error);
        }
        socket.terminate();
      });
      socket.on("close", () => {
        clearTimeout(connectTimeout);
        if (authProbeTimer) {
          clearTimeout(authProbeTimer);
        }
        if (this.sockets.get(relay) === socket) {
          this.sockets.delete(relay);
        }
        if (!wasReady) {
          rejectReady(new Error("error: backend relay connection closed"));
          return;
        }
        if (this.connections.get(relay) === connection) {
          this.connections.delete(relay);
        }
        this.rejectPendingPublications(connection, "error: backend relay connection closed");
        connection.subscriptions.clear();
        this.scheduleReconnect(relay, "error: backend relay connection closed");
      });
      socket.on("message", (raw) => {
        this.messageHandler.handle(connection, raw, {
          failConnection,
          onAuthChallenge: () => {
            if (authProbeTimer) {
              clearTimeout(authProbeTimer);
            }
          },
          onAuthReady: resolveReady,
          onSubscriptionClosed: (backendSubId) => this.subscriptionRegistry.forget(relay, backendSubId),
        });
      });
    });
  }

  private restoreSubscriptions(connection: RelayConnection): void {
    for (const subscription of this.subscriptionRegistry.activeFor(connection.url)) {
      this.attachSubscription(connection, subscription);
    }
  }

  private attachSubscription(connection: RelayConnection, subscription: BackendSubscription): void {
    if (connection.subscriptions.get(subscription.backendSubId) === subscription) {
      return;
    }
    connection.subscriptions.set(subscription.backendSubId, subscription);
    connection.socket.send(
      JSON.stringify(["REQ", subscription.backendSubId, ...subscription.filters]),
    );
  }

  private rejectPendingPublications(connection: RelayConnection, reason: string): void {
    for (const pendingEntry of connection.pendingOk.values()) {
      clearTimeout(pendingEntry.timeout);
      pendingEntry.reject(new Error(reason));
    }
    connection.pendingOk.clear();
  }

  private scheduleReconnect(relay: string, reason: string): void {
    if (
      this.stopped ||
      this.authFailures.has(relay) ||
      this.connections.get(relay)?.socket.readyState === WebSocket.OPEN ||
      this.connecting.has(relay) ||
      this.reconnectScheduler.isScheduled(relay)
    ) {
      return;
    }

    this.reconnectScheduler.schedule(relay, reason, () => {
      void this.startConnection(relay);
    });
  }
}
