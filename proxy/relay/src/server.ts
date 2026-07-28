import { createServer, type Server } from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { DbClient, DbApiError } from "@orchestrator/db-client";
import type { Filter, NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";
import { getPlanConfig } from "./plan.js";
import { getNpubFromPubkey, verifyNip42AuthEvent } from "./nostr.js";
import { type RelayConfig, loadRelayConfig } from "./config.js";
import { BoundedEventDedup } from "./dedup.js";
import { isValidForwardableEvent } from "./event-validation.js";
import {
  closedMessage,
  normalizeReason,
  okMessage,
  validateSubscriptionId,
} from "./protocol.js";
import {
  RelayPool,
  type BackendSubStatus,
  type PublishResult,
  type SubscriptionHandle,
} from "./relay.js";

type FrontendSubscription = {
  generation: number;
  closed: boolean;
  eoseSent: boolean;
  settledBackends: Set<string>;
  expectedBackends: number;
  handle: SubscriptionHandle | null;
  dedup: BoundedEventDedup;
  filters: Filter[];
  abortController: AbortController;
  frontendClosedReason?: string;
};

type RelaySocketState = {
  pubkey?: string;
  npub?: string;
  subscriptions: Map<string, FrontendSubscription>;
  generationCounter: number;
};

export type RelayServer = {
  app: express.Express;
  server: Server;
  wss: WebSocketServer;
  relayPool: RelayPool;
  relayConfig: RelayConfig;
  listen: () => Promise<number>;
  close: () => Promise<void>;
};

export type CreateRelayServerOptions = {
  relayConfig?: RelayConfig;
  relayPool?: RelayPool;
  db?: DbClient;
};

function buildNip11Document(relayConfig: RelayConfig) {
  return {
    name: "nostr-storage-orchestrator relay",
    description: "Authenticated-write Nostr relay proxy with multi-backend aggregation",
    supported_nips: [1, 11, 42],
    software: relayConfig.software,
    version: relayConfig.version,
    limitation: {
      auth_required: false,
      restricted_writes: true,
      max_subid_length: 64,
    },
  };
}

function setNip11Cors(res: express.Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

export function createRelayServer(options: CreateRelayServerOptions = {}): RelayServer {
  const relayConfig = options.relayConfig ?? loadRelayConfig();
  const relayPool =
    options.relayPool ??
    new RelayPool({
      relays: relayConfig.backendRelays,
      initialEoseTimeoutMs: relayConfig.initialEoseTimeoutMs,
      publishAckTimeoutMs: relayConfig.publishAckTimeoutMs,
      ...(relayConfig.backendAuthSecretKey ? { backendAuthSecretKey: relayConfig.backendAuthSecretKey } : {}),
    });
  const db =
    options.db ??
    new DbClient({
      baseUrl: process.env.DB_API_URL ?? `http://localhost:${process.env.DB_API_PORT}`,
    });

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  const nip11Document = buildNip11Document(relayConfig);

  app.options("/", (_req, res) => {
    setNip11Cors(res);
    res.status(204).end();
  });

  app.get("/", (req, res) => {
    const accept = req.headers.accept ?? "";
    if (accept.includes("application/nostr+json")) {
      setNip11Cors(res);
      res.setHeader("Content-Type", "application/nostr+json");
      res.status(200).json(nip11Document);
      return;
    }
    res.status(200).send("Nostr relay");
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const relayUrl = relayConfig.publicUrl;
  const authState = new Map<WebSocket, RelaySocketState>();

  function getAuthState(socket: WebSocket): RelaySocketState {
    let state = authState.get(socket);
    if (!state) {
      state = { subscriptions: new Map(), generationCounter: 0 };
      authState.set(socket, state);
    }
    return state;
  }

  function sendJson(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  function validateEvent(event: NostrEvent): void {
    if (!verifyEvent(event)) {
      throw new Error("invalid: event signature verification failed");
    }
  }

  function isInitialTerminalStatus(status: BackendSubStatus): boolean {
    return status === "eose" || status === "timed-out" || status === "failed" || status === "closed";
  }

  function maybeSendAggregatedEose(socket: WebSocket, subId: string, subscription: FrontendSubscription): void {
    if (subscription.closed || subscription.eoseSent) {
      return;
    }
    if (subscription.settledBackends.size < subscription.expectedBackends) {
      return;
    }
    subscription.eoseSent = true;
    sendJson(socket, ["EOSE", subId]);
  }

  function terminateFrontendSubscription(
    socket: WebSocket,
    subId: string,
    state: RelaySocketState,
    reason: string,
  ): void {
    const subscription = state.subscriptions.get(subId);
    if (!subscription || subscription.closed) {
      return;
    }
    subscription.closed = true;
    subscription.frontendClosedReason = reason;
    subscription.abortController.abort();
    subscription.handle?.suppress();
    subscription.handle?.close();
    state.subscriptions.delete(subId);
    sendJson(socket, closedMessage(subId, reason));
  }

  function closeFrontendSubscription(subId: string, state: RelaySocketState): void {
    const subscription = state.subscriptions.get(subId);
    if (!subscription || subscription.closed) {
      return;
    }
    subscription.closed = true;
    subscription.abortController.abort();
    subscription.handle?.suppress();
    subscription.handle?.close();
    state.subscriptions.delete(subId);
  }

  function evaluatePublication(
    results: PublishResult[],
    requiredCount: number,
  ): { success: true; acceptedRelays: string[] } | { success: false; reason: string; acceptedRelays: string[] } {
    const accepted = results.filter((entry) => entry.accepted);
    if (accepted.length === 0) {
      const details = results.map((entry) => `${entry.relay}: ${entry.message}`).join("; ");
      return {
        success: false,
        reason: normalizeReason(`no backend relays accepted the event (${details})`),
        acceptedRelays: [],
      };
    }
    if (accepted.length < requiredCount) {
      const details = results
        .filter((entry) => !entry.accepted)
        .map((entry) => `${entry.relay}: ${entry.message}`)
        .join("; ");
      return {
        success: false,
        reason: normalizeReason(
          `replication incomplete; accepted ${accepted.length} of ${requiredCount} backend relays (${details})`,
        ),
        acceptedRelays: accepted.map((entry) => entry.relay),
      };
    }
    return { success: true, acceptedRelays: accepted.map((entry) => entry.relay) };
  }

  async function reserveStorage(event: NostrEvent, npub: string, size: number): Promise<boolean> {
    try {
      const existing = await db.getRelayEvent(event.id);
      if (existing) {
        return true;
      }

      const user = await db.getUser(npub);
      if (!user) {
        return false;
      }

      const planConfig = await getPlanConfig(db);
      if (Number(user.usedStorage) + size > planConfig[user.plan].storageLimit) {
        return false;
      }

      await db.createRelayEvent({
        eventId: event.id,
        npub,
        kind: event.kind,
        size,
      });
      return true;
    } catch (error) {
      if (error instanceof DbApiError && error.status === 409) {
        return true;
      }
      return false;
    }
  }

  async function rollbackStorage(eventId: string): Promise<void> {
    await db.rollbackRelayEvent(eventId);
  }

  function startFrontendSubscription(
    socket: WebSocket,
    state: RelaySocketState,
    subId: string,
    filters: Filter[],
  ): void {
    if (relayConfig.backendRelays.length === 0) {
      sendJson(socket, closedMessage(subId, "error: no backend relays are available"));
      return;
    }

    const generation = ++state.generationCounter;
    const abortController = new AbortController();
    const subscription: FrontendSubscription = {
      generation,
      closed: false,
      eoseSent: false,
      settledBackends: new Set(),
      expectedBackends: relayConfig.backendRelays.length,
      handle: null,
      dedup: new BoundedEventDedup(),
      filters,
      abortController,
    };

    state.subscriptions.set(subId, subscription);

    const handle = relayPool.subscribe(
      filters,
      {
        onEvent: (event, _relay) => {
          const active = state.subscriptions.get(subId);
          if (!active || active.closed || active.generation !== generation) {
            return;
          }
          if (!isValidForwardableEvent(event, active.filters)) {
            return;
          }
          if (!active.dedup.add(event.id)) {
            return;
          }
          sendJson(socket, ["EVENT", subId, event]);
        },
        onBackendInitialSettled: (_relay, backendSubId, status) => {
          const active = state.subscriptions.get(subId);
          if (!active || active.closed || active.generation !== generation) {
            return;
          }
          if (!isInitialTerminalStatus(status)) {
            return;
          }
          if (!active.settledBackends.has(backendSubId)) {
            active.settledBackends.add(backendSubId);
            maybeSendAggregatedEose(socket, subId, active);
          }
        },
        onBackendClosed: (_relay, _backendSubId, reason) => {
          const active = state.subscriptions.get(subId);
          if (!active || active.closed || active.generation !== generation) {
            return;
          }
          const handleRef = active.handle;
          if (!handleRef) {
            return;
          }
          const statuses = handleRef.getBackendStatuses();
          const allClosed = statuses.every(
            (entry) => entry.status === "closed" || entry.status === "failed",
          );
          if (allClosed) {
            terminateFrontendSubscription(socket, subId, state, reason);
          }
        },
      },
      {
        targetRelays: relayConfig.backendRelays,
        generation,
        signal: abortController.signal,
      },
    );

    subscription.handle = handle;
    subscription.expectedBackends = handle.backendSubs.length;
  }

  wss.on("connection", (socket) => {
    const state = getAuthState(socket);
    const challenge = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sendJson(socket, ["AUTH", challenge]);

    socket.on("message", async (raw) => {
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        sendJson(socket, ["NOTICE", "invalid: malformed relay message"]);
        return;
      }

      if (!Array.isArray(payload)) {
        sendJson(socket, ["NOTICE", "invalid: malformed relay message"]);
        return;
      }

      const [messageType, ...rest] = payload as unknown[];

      try {
        if (messageType === "AUTH") {
          const [authEvent] = rest as [NostrEvent];
          try {
            const pubkey = verifyNip42AuthEvent(authEvent, challenge, relayUrl);
            state.pubkey = pubkey;
            state.npub = getNpubFromPubkey(pubkey);
            sendJson(socket, okMessage(authEvent.id, true));
          } catch (error) {
            const reason = error instanceof Error ? error.message : "invalid: authentication failed";
            sendJson(socket, okMessage(authEvent.id, false, reason));
          }
          return;
        }

        if (messageType === "EVENT") {
          const [event] = rest as [NostrEvent];
          validateEvent(event);

          // Require a completed NIP-42 AUTH on this connection, but do not
          // require event.pubkey === auth pubkey. Clients like Formstr AUTH as
          // the user and publish form/giftwrap events under ephemeral keys;
          // event authorship is still enforced via signature verification below.
          if (!state.npub || !state.pubkey) {
            sendJson(socket, okMessage(event.id, false, "auth-required: authenticate before publishing"));
            return;
          }

          if (event.kind === 5) {
            const deletionTarget = event.tags.find((tag) => tag[0] === "e")?.[1];
            if (!deletionTarget) {
              sendJson(socket, okMessage(event.id, false, "invalid: deletion target is missing"));
              return;
            }

            const existing = await db.getRelayEvent(deletionTarget);
            if (!existing || existing.npub !== state.npub) {
              sendJson(socket, okMessage(event.id, false, "restricted: deletion is not authorized"));
              return;
            }

            const deletionEvent = { ...event, kind: 5 } as NostrEvent;
            const targetRelays = existing.replicas.length > 0 ? existing.replicas : relayConfig.backendRelays;
            let healthyRelays: string[];
            try {
              healthyRelays = targetRelays.filter((relay: string) => relayConfig.backendRelays.includes(relay));
              if (healthyRelays.length === 0) {
                healthyRelays = await relayPool.selectHealthyRelays(1);
              }
            } catch (error) {
              const reason = error instanceof Error ? error.message : "error: no backend relays are available";
              sendJson(socket, okMessage(event.id, false, reason));
              return;
            }

            const results = await relayPool.delete(deletionEvent, healthyRelays);
            const evaluation = evaluatePublication(results, healthyRelays.length);
            if (!evaluation.success) {
              const remainingReplicas = results.filter((entry) => !entry.accepted).map((entry) => entry.relay);
              if (remainingReplicas.length > 0) {
                await db.setRelayEventReplicas(existing.eventId, remainingReplicas);
              }
              sendJson(socket, okMessage(event.id, false, evaluation.reason));
              return;
            }

            await db.deleteRelayEvent(existing.eventId);
            sendJson(socket, okMessage(event.id, true));
            return;
          }

          const npub = getNpubFromPubkey(event.pubkey);
          const user = await db.upsertUser(npub);

          const planConfig = (await getPlanConfig(db))[user.plan];
          const size = Buffer.byteLength(JSON.stringify(event), "utf8");
          if (size > planConfig.uploadLimit) {
            sendJson(socket, okMessage(event.id, false, "restricted: file exceeds upload limit"));
            return;
          }

          const reserved = await reserveStorage(event, npub, size);
          if (!reserved) {
            sendJson(socket, okMessage(event.id, false, "restricted: storage limit exceeded"));
            return;
          }

          let healthyRelays: string[];
          try {
            healthyRelays = await relayPool.selectHealthyRelays(planConfig.replicaCount);
          } catch (error) {
            await rollbackStorage(event.id);
            const reason = error instanceof Error ? error.message : "error: no backend relays are available";
            sendJson(socket, okMessage(event.id, false, reason));
            return;
          }

          const results = await relayPool.publish(event, healthyRelays);
          const evaluation = evaluatePublication(results, planConfig.replicaCount);
          if (!evaluation.success) {
            if (evaluation.acceptedRelays.length === 0) {
              await rollbackStorage(event.id);
            } else {
              await db.setRelayEventReplicas(event.id, evaluation.acceptedRelays);
            }
            sendJson(socket, okMessage(event.id, false, evaluation.reason));
            return;
          }

          await db.setRelayEventReplicas(event.id, evaluation.acceptedRelays);
          sendJson(socket, okMessage(event.id, true));
          return;
        }

        if (messageType === "REQ") {
          const [rawSubId, ...filters] = rest as [unknown, ...Filter[]];
          const validation = validateSubscriptionId(rawSubId);
          if (!validation.valid) {
            if (typeof rawSubId === "string" && rawSubId.length > 0) {
              sendJson(socket, closedMessage(rawSubId, validation.reason));
            } else {
              sendJson(socket, ["NOTICE", validation.reason]);
            }
            return;
          }

          const subId = validation.subId;
          const existing = state.subscriptions.get(subId);
          if (existing) {
            closeFrontendSubscription(subId, state);
          }

          startFrontendSubscription(socket, state, subId, filters);
          return;
        }

        if (messageType === "CLOSE") {
          const [rawSubId] = rest as [unknown];
          if (typeof rawSubId === "string") {
            closeFrontendSubscription(rawSubId, state);
          }
          return;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "error: internal server error";
        sendJson(socket, ["NOTICE", normalizeReason(reason)]);
      }
    });

    socket.on("close", () => {
      for (const subId of [...state.subscriptions.keys()]) {
        closeFrontendSubscription(subId, state);
      }
      authState.delete(socket);
    });
  });

  return {
    app,
    server,
    wss,
    relayPool,
    relayConfig,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("failed to bind relay server"));
            return;
          }
          resolve(address.port);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        relayPool.closeAll();
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
  };
}
