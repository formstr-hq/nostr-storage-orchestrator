import type { NostrEvent } from "nostr-tools";
import { finalizeEvent, type EventTemplate } from "nostr-tools/pure";
import type { RawData } from "ws";
import { normalizeReason } from "./protocol.js";
import type { BackendSubscription, RelayConnection, RelayLogger } from "./relay-types.js";

type MessageHandlerCallbacks = {
  failConnection: (reason: string) => void;
  onAuthChallenge: () => void;
  onAuthReady: () => void;
};

export class BackendMessageHandler {
  constructor(
    private readonly logger: RelayLogger,
    private readonly backendAuthSecretKey: Uint8Array | undefined,
    private readonly waitForOk: (
      connection: RelayConnection,
      eventId: string,
    ) => Promise<{ accepted: boolean; message: string }>,
  ) {}

  handle(connection: RelayConnection, raw: RawData, callbacks: MessageHandlerCallbacks): void {
    let payload: unknown;
    try {
      payload = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      this.logger.warn?.("invalid backend JSON", { relay: connection.url });
      return;
    }
    if (!Array.isArray(payload)) {
      return;
    }

    const [messageType, ...rest] = payload as [string, ...unknown[]];
    if (messageType === "AUTH") {
      this.handleAuth(connection, rest[0], callbacks);
      return;
    }
    if (messageType === "OK") {
      this.handleOk(connection, rest);
      return;
    }
    if (messageType === "NOTICE") {
      const notice = typeof rest[0] === "string" ? rest[0] : "backend notice";
      this.logger.info?.("backend notice", { relay: connection.url, notice });
      return;
    }
    if (messageType === "EOSE") {
      this.handleEose(connection, rest[0]);
      return;
    }
    if (messageType === "CLOSED") {
      this.handleClosed(connection, rest[0], rest[1]);
      return;
    }
    if (messageType === "EVENT") {
      this.handleEvent(connection, rest[0], rest[1]);
    }
  }

  private handleAuth(
    connection: RelayConnection,
    challenge: unknown,
    callbacks: MessageHandlerCallbacks,
  ): void {
    callbacks.onAuthChallenge();
    if (typeof challenge !== "string") {
      return;
    }
    if (!this.backendAuthSecretKey) {
      callbacks.failConnection("auth-required: backend relay requires authentication");
      return;
    }

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
    const acknowledgement = this.waitForOk(connection, authEvent.id);
    connection.socket.send(JSON.stringify(["AUTH", authEvent]));
    void acknowledgement.then(callbacks.onAuthReady).catch((error: unknown) => {
      callbacks.failConnection(
        error instanceof Error ? error.message : "auth-required: backend authentication failed",
      );
    });
  }

  private handleOk(connection: RelayConnection, rest: unknown[]): void {
    const eventId = rest[0];
    const accepted = rest[1] === true;
    const reason = typeof rest[2] === "string" ? rest[2] : "";
    if (typeof eventId !== "string") {
      return;
    }
    const pending = connection.pendingOk.get(eventId);
    if (!pending) {
      return;
    }
    connection.pendingOk.delete(eventId);
    clearTimeout(pending.timeout);
    pending.resolve({
      accepted,
      message: accepted ? "" : normalizeReason(reason || "blocked: event rejected", "blocked:"),
    });
  }

  private handleEose(connection: RelayConnection, subId: unknown): void {
    const subscription = this.getActiveSubscription(connection, subId);
    if (!subscription) {
      return;
    }
    if (subscription.eoseTimer) {
      clearTimeout(subscription.eoseTimer);
    }
    if (!subscription.initialSettled) {
      subscription.initialStatus = "eose";
      subscription.onInitialSettled("eose");
    }
  }

  private handleClosed(connection: RelayConnection, subId: unknown, rawReason: unknown): void {
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
    const reason = normalizeReason(
      typeof rawReason === "string" ? rawReason : "error: backend subscription closed",
    );
    if (!subscription.initialSettled) {
      subscription.onInitialSettled("closed", reason);
    }
    subscription.onBackendClosed(reason);
  }

  private handleEvent(connection: RelayConnection, subId: unknown, event: unknown): void {
    const subscription = this.getActiveSubscription(connection, subId);
    if (subscription && event && typeof event === "object") {
      subscription.onEvent(event as NostrEvent);
    }
  }

  private getActiveSubscription(
    connection: RelayConnection,
    subId: unknown,
  ): BackendSubscription | undefined {
    if (typeof subId !== "string") {
      return undefined;
    }
    const subscription = connection.subscriptions.get(subId);
    return subscription && !subscription.closed ? subscription : undefined;
  }
}
