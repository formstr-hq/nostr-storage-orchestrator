import { createHash } from "node:crypto";
import type { NostrEvent } from "nostr-tools";
import { WebSocket } from "ws";
import { BackendConnectionManager } from "./backend-connection.js";
import { normalizeReason } from "./protocol.js";
import type {
  BackendSubscription,
  BackendSubscriptionRef,
  PublishResult,
  RelayPoolOptions,
  SubscriptionCallbacks,
  SubscriptionHandle,
} from "./relay-types.js";

export type {
  BackendSubStatus,
  BackendSubscriptionRef,
  PublishResult,
  RelayLogger,
  RelayPoolOptions,
  SubscriptionCallbacks,
  SubscriptionHandle,
} from "./relay-types.js";

export class RelayPool {
  private readonly relays: string[];
  private readonly initialEoseTimeoutMs: number;
  private readonly connectionManager: BackendConnectionManager;

  constructor(options: RelayPoolOptions = {}) {
    this.relays = options.relays ?? [];
    this.initialEoseTimeoutMs = options.initialEoseTimeoutMs ?? 5000;
    this.connectionManager = new BackendConnectionManager(options);
  }

  async publish(event: NostrEvent, targetRelays: string[] = this.relays): Promise<PublishResult[]> {
    const settled = await Promise.allSettled(
      targetRelays.map(async (relay): Promise<PublishResult> => {
        try {
          const connection = await this.connectionManager.get(relay);
          if (connection.authUnavailable) {
            return {
              relay,
              accepted: false,
              message: connection.authUnavailableReason ?? "auth-required: backend relay requires authentication",
            };
          }
          const acknowledgement = this.connectionManager.waitForOk(connection, event.id);
          connection.socket.send(JSON.stringify(["EVENT", event]));
          const result = await acknowledgement;
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

    if (options.signal) {
      if (options.signal.aborted) {
        suppressed = true;
        closed = true;
      } else {
        options.signal.addEventListener("abort", () => handle.close(), { once: true });
      }
    }

    handle.initialSync = Promise.allSettled(
      targetRelays.map(async (relay) => {
        const backendSubId = createHash("sha256")
          .update(`${relay}:${Date.now()}:${Math.random()}`)
          .digest("hex");
        const ref: BackendSubscriptionRef = { relay, backendSubId, status: "pending" };
        backendRefs.push(ref);

        if (closed || suppressed || options.signal?.aborted) {
          ref.status = "closed";
          return;
        }

        try {
          const connection = await this.connectionManager.get(relay);
          if (connection.authUnavailable) {
            const reason =
              connection.authUnavailableReason ?? "auth-required: backend relay requires authentication";
            ref.status = "failed";
            ref.reason = reason;
            callbacks.onBackendInitialSettled(relay, backendSubId, "failed", reason);
            return;
          }

          const subscription = this.createBackendSubscription({
            backendSubId,
            relay,
            generation,
            ref,
            callbacks,
            isInactive: () => suppressed || closed,
          });
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
    this.connectionManager.closeSubscription(relay, backendSubId);
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
          const connection = await this.connectionManager.get(relay);
          return {
            relay,
            healthy: connection.socket.readyState === WebSocket.OPEN && !connection.authUnavailable,
          };
        } catch {
          return { relay, healthy: false };
        }
      }),
    );
  }

  async selectHealthyRelays(count: number): Promise<string[]> {
    const healthy = (await this.health()).filter((entry) => entry.healthy).map((entry) => entry.relay);
    if (healthy.length < count) {
      throw new Error(`error: insufficient healthy relays: expected ${count}, found ${healthy.length}`);
    }
    return healthy.slice(0, count);
  }

  closeAll(): void {
    this.connectionManager.closeAll();
  }

  private createBackendSubscription({
    backendSubId,
    relay,
    generation,
    ref,
    callbacks,
    isInactive,
  }: {
    backendSubId: string;
    relay: string;
    generation: number;
    ref: BackendSubscriptionRef;
    callbacks: SubscriptionCallbacks;
    isInactive: () => boolean;
  }): BackendSubscription {
    const subscription: BackendSubscription = {
      backendSubId,
      relay,
      generation,
      initialStatus: "pending",
      initialSettled: false,
      closed: false,
      onEvent: (event) => {
        if (!isInactive() && subscription.generation === generation) {
          callbacks.onEvent(event, relay);
        }
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
    return subscription;
  }

  private closeHandle(handle: SubscriptionHandle): void {
    for (const backendSub of handle.backendSubs) {
      if (backendSub.status !== "closed" && backendSub.status !== "failed") {
        this.closeSubscription(backendSub.relay, backendSub.backendSubId);
        backendSub.status = "closed";
      }
    }
  }
}
