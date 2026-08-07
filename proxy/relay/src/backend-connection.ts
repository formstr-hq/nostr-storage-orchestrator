import { WebSocket } from "ws";
import { BackendMessageHandler } from "./backend-message-handler.js";
import { normalizeReason } from "./protocol.js";
import type { RelayConnection, RelayLogger, RelayPoolOptions } from "./relay-types.js";

const defaultLogger: RelayLogger = {};

export class BackendConnectionManager {
  private readonly publishAckTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly backendAuthProbeMs: number;
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly messageHandler: BackendMessageHandler;
  private readonly connections = new Map<string, RelayConnection>();
  private readonly connecting = new Map<string, Promise<RelayConnection>>();

  constructor(options: RelayPoolOptions) {
    this.publishAckTimeoutMs = options.publishAckTimeoutMs ?? 5000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.backendAuthProbeMs = options.backendAuthProbeMs ?? 25;
    this.wsFactory = options.wsFactory ?? ((url) => new WebSocket(url));
    this.messageHandler = new BackendMessageHandler(
      options.logger ?? defaultLogger,
      options.backendAuthSecretKey,
      (connection, eventId) => this.waitForOk(connection, eventId),
    );
  }

  async get(relay: string): Promise<RelayConnection> {
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

    const connectionPromise = this.connect(relay);
    this.connecting.set(relay, connectionPromise);
    return connectionPromise;
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

  private connect(relay: string): Promise<RelayConnection> {
    return new Promise<RelayConnection>((resolve, reject) => {
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

      const cleanup = () => {
        this.connections.delete(relay);
        this.connecting.delete(relay);
      };
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
      const failConnection = (reason: string) => {
        connection.authUnavailable = true;
        connection.authUnavailableReason = normalizeReason(reason, "auth-required:");
        rejectReady(new Error(connection.authUnavailableReason));
        this.rejectPendingOperations(connection, connection.authUnavailableReason);
      };

      const connectTimeout = setTimeout(() => {
        socket.terminate();
        rejectReady(new Error(`error: timed out connecting to backend relay ${relay}`));
      }, this.connectTimeoutMs);

      socket.on("open", () => {
        // Give an authentication-required backend time to issue its NIP-42 challenge.
        authProbeTimer = setTimeout(resolveReady, this.backendAuthProbeMs);
      });
      socket.on("error", rejectReady);
      socket.on("close", () => {
        clearTimeout(connectTimeout);
        cleanup();
        this.rejectPendingOperations(connection, "error: backend relay connection closed", true);
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
        });
      });
    });
  }

  private rejectPendingOperations(
    connection: RelayConnection,
    reason: string,
    settleInitialSubscriptions = false,
  ): void {
    for (const pendingEntry of connection.pendingOk.values()) {
      clearTimeout(pendingEntry.timeout);
      pendingEntry.reject(new Error(reason));
    }
    connection.pendingOk.clear();
    for (const subscription of [...connection.subscriptions.values()]) {
      if (subscription.eoseTimer) {
        clearTimeout(subscription.eoseTimer);
      }
      if (settleInitialSubscriptions && !subscription.initialSettled) {
        subscription.onInitialSettled("failed", reason);
      }
      subscription.onBackendClosed(reason);
    }
    connection.subscriptions.clear();
  }
}
