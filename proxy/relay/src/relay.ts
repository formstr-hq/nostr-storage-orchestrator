import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NostrEvent } from "nostr-tools";
import { config } from "dotenv";
import { WebSocket } from "ws";
import { DbClient } from "@orchestrator/db-client";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

const FALLBACK_RELAYS = (process.env.BACKEND_RELAYS ?? "")
  .split(",")
  .map((relay) => relay.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const POLL_MS = positiveNumber(process.env.STORAGE_REGISTRY_POLL_MS, 15_000);
const RAW_URL = /^(?:https?|wss?):\/\//i;

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export type RelayCandidate = { id: string; url: string };

export class RelayRegistry {
  private byId = new Map<string, string>();
  private listeners = new Set<(urls: Set<string>) => void>();
  private warnedFallback = false;

  constructor(
    private readonly db: Pick<DbClient, "listActiveStorages">,
    private readonly fallbackUrls = FALLBACK_RELAYS,
  ) {}

  async refresh(): Promise<void> {
    try {
      const active = await this.db.listActiveStorages();
      if (active.length === 0) {
        this.useFallback();
        return;
      }
      this.byId = new Map(
        active.map((storage) => [
          storage.npub,
          `ws://${hostForUrl(storage.tunnelIp)}:${storage.relayPort}`,
        ]),
      );
      this.emit();
    } catch (error) {
      console.error(
        "Failed to refresh relay storage registry; retaining last good state",
        error,
      );
    }
  }

  candidates(): RelayCandidate[] {
    return [...this.byId].map(([id, url]) => ({ id, url }));
  }

  urls(): string[] {
    return [...this.byId.values()];
  }

  resolve(id: string): string | undefined {
    return RAW_URL.test(id) ? id : this.byId.get(id);
  }

  resolveId(idOrUrl: string): string | undefined {
    if (this.byId.has(idOrUrl)) {
      return idOrUrl;
    }
    for (const [id, url] of this.byId) {
      if (url === idOrUrl) {
        return id;
      }
    }
    return undefined;
  }

  onChange(listener: (urls: Set<string>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private useFallback(): void {
    this.byId = new Map(this.fallbackUrls.map((url) => [url, url]));
    if (
      this.fallbackUrls.length > 0 &&
      process.env.NODE_ENV === "production" &&
      !this.warnedFallback
    ) {
      this.warnedFallback = true;
      console.warn(
        "Using BACKEND_RELAYS fallback because the DB active storage list is empty",
      );
    }
    this.emit();
  }

  private emit(): void {
    const urls = new Set(this.byId.values());
    for (const listener of this.listeners) {
      listener(urls);
    }
  }
}

const registryDb = new DbClient({
  baseUrl:
    process.env.DB_API_URL ?? `http://localhost:${process.env.DB_API_PORT}`,
});
export const relayRegistry = new RelayRegistry(registryDb);
if (process.env.NODE_ENV !== "test") {
  void relayRegistry.refresh();
  setInterval(() => void relayRegistry.refresh(), POLL_MS).unref();
}

/**
 * Pool of backend relay connections backed by a registry-driven set of URLs.
 *
 * The registry resolves stable candidate ids (npubs / fallback URLs) into
 * live WebSocket URLs and emits change events. The pool keeps a
 * BackendConnectionManager in sync with the active URL set and subscribes /
 * publishes through it.
 */
export class RelayPool {
  private readonly relays: string[];
  private readonly initialEoseTimeoutMs: number;
  private readonly connectionManager: BackendConnectionManager;
  private readonly registry: RelayRegistry | undefined;
  private readonly unsubscribeRegistry: (() => void) | undefined;

  constructor(options: RelayPoolOptions & { registry?: RelayRegistry } = {}) {
    this.registry = options.registry;
    this.connectionManager = new BackendConnectionManager(options);
    this.initialEoseTimeoutMs = options.initialEoseTimeoutMs ?? 5000;

    if (this.registry) {
      this.unsubscribeRegistry = this.registry.onChange((urls) =>
        this.syncRelays(urls),
      );
      this.relays = this.registry.urls();
    } else {
      this.relays = options.relays ?? [];
    }
  }

  async publish(
    event: NostrEvent,
    targetRelays?: string[],
  ): Promise<PublishResult[]> {
    const targets = this.resolveTargets(targetRelays);
    const settled = await Promise.allSettled(
      targets.map(async (relay): Promise<PublishResult> => {
        try {
          const connection = await this.connectionManager.get(relay);
          if (connection.authUnavailable) {
            return {
              relay,
              accepted: false,
              message:
                connection.authUnavailableReason ??
                "auth-required: backend relay requires authentication",
            };
          }
          const acknowledgement = this.connectionManager.waitForOk(
            connection,
            event.id,
          );
          connection.socket.send(JSON.stringify(["EVENT", event]));
          const result = await acknowledgement;
          return { relay, accepted: result.accepted, message: result.message };
        } catch (error) {
          return {
            relay,
            accepted: false,
            message: normalizeReason(
              error instanceof Error ? error.message : "publish failed",
            ),
          };
        }
      }),
    );

    return settled.map((entry, index) => {
      const relay = targets[index] ?? "unknown";
      if (entry.status === "fulfilled") {
        return entry.value;
      }
      return {
        relay,
        accepted: false,
        message: normalizeReason(
          entry.reason instanceof Error ? entry.reason.message : "publish failed",
        ),
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
    const targetRelays = this.resolveTargets(options.targetRelays);
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
        options.signal.addEventListener("abort", () => handle.close(), {
          once: true,
        });
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

        const subscription = this.createBackendSubscription({
          backendSubId,
          relay,
          generation,
          filters,
          ref,
          callbacks,
          isInactive: () => suppressed || closed,
        });
        subscription.eoseTimer = setTimeout(() => {
          if (!subscription.initialSettled) {
            subscription.initialStatus = "timed-out";
            subscription.onInitialSettled(
              "timed-out",
              "error: initial query timed out",
            );
          }
        }, this.initialEoseTimeoutMs);

        try {
          await this.connectionManager.openSubscription(subscription);
        } catch (error) {
          const reason = normalizeReason(
            error instanceof Error ? error.message : "connection failed",
          );
          if (reason.startsWith("auth-required:")) {
            if (!subscription.initialSettled) {
              subscription.onInitialSettled("failed", reason);
            }
            this.connectionManager.closeSubscription(relay, backendSubId);
          }
        }
      }),
    ).then(() => undefined);

    return handle;
  }

  closeSubscription(relay: string, backendSubId: string): void {
    this.connectionManager.closeSubscription(relay, backendSubId);
  }

  async delete(
    event: NostrEvent,
    targetRelays?: string[],
  ): Promise<PublishResult[]> {
    return this.publish(event, targetRelays);
  }

  async health(): Promise<Array<{ relay: string; healthy: boolean; id: string | undefined }>> {
    const urls = this.activeRelays();
    if (urls.length === 0) {
      return [];
    }
    return Promise.all(
      urls.map(async (relay) => {
        try {
          const connection = await this.connectionManager.get(relay);
          return {
            relay,
            healthy:
              connection.socket.readyState === WebSocket.OPEN &&
              !connection.authUnavailable,
            id: this.registry?.resolveId(relay),
          };
        } catch {
          return { relay, healthy: false, id: this.registry?.resolveId(relay) };
        }
      }),
    );
  }

  async selectHealthyRelays(count: number): Promise<string[]> {
    const healthy = (await this.health())
      .filter((entry) => entry.healthy)
      .map((entry) => entry.relay);
    if (healthy.length < count) {
      throw new Error(
        `error: insufficient healthy relays: expected ${count}, found ${healthy.length}`,
      );
    }
    return healthy.slice(0, count);
  }

  closeAll(): void {
    this.unsubscribeRegistry?.();
    this.connectionManager.closeAll();
  }

  private resolveTargets(targets?: string[]): string[] {
    if (targets && targets.length > 0) {
      if (!this.registry) {
        return targets;
      }
      return targets
        .map((idOrUrl) => this.resolveTarget(idOrUrl))
        .filter((url): url is string => Boolean(url));
    }
    return this.activeRelays();
  }

  private resolveTarget(idOrUrl: string): string | undefined {
    if (RAW_URL.test(idOrUrl)) {
      return idOrUrl;
    }
    return this.registry?.resolve(idOrUrl);
  }

  private activeRelays(): string[] {
    return this.relays;
  }

  private syncRelays(urls: Set<string>): void {
    this.relays.length = 0;
    for (const url of urls) {
      this.relays.push(url);
    }
    this.connectionManager.evictStale(urls);
  }

  private createBackendSubscription({
    backendSubId,
    relay,
    generation,
    filters,
    ref,
    callbacks,
    isInactive,
  }: {
    backendSubId: string;
    relay: string;
    generation: number;
    filters: Record<string, unknown>[];
    ref: BackendSubscriptionRef;
    callbacks: SubscriptionCallbacks;
    isInactive: () => boolean;
  }): BackendSubscription {
    const subscription: BackendSubscription = {
      backendSubId,
      relay,
      generation,
      filters,
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
