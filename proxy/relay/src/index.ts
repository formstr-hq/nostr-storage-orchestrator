import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { DbClient, DbApiError } from "@orchestrator/db-client";
import { getPlanConfig } from "./plan.js";
import { getNpubFromPubkey, verifyNip42AuthEvent } from "./nostr.js";
import { RelayPool } from "./relay.js";
import { verifyEvent, type NostrEvent } from "nostr-tools";

type BackendSub = { relay: string; backendSubId: string };

type RelaySocketState = {
    pubkey?: string;
    npub?: string;
    subscriptions: Map<string, { closed: boolean; backendSubs: BackendSub[] }>;
};

const app = express();
app.use(express.json({ limit: "10mb" }));

const server = createServer(app);
const wss = new WebSocketServer({ server });
const relayPool = new RelayPool();
const PORT = process.env.RELAY_PORT!;
const relayUrl = process.env.PUBLIC_URL ?? `ws://localhost:${PORT}`;
const authState = new Map<WebSocket, RelaySocketState>();

// db-api always runs on the same host (both are host-networked in Docker,
// see docker-compose.yml), so this is derived from its port rather than
// duplicated as its own var — override DB_API_URL directly if that ever
// stops being true.
const db = new DbClient({
    baseUrl: process.env.DB_API_URL ?? `http://localhost:${process.env.DB_API_PORT}`,
});

function getAuthState(socket: WebSocket): RelaySocketState {
    let state = authState.get(socket);
    if (!state) {
        state = { subscriptions: new Map() };
        authState.set(socket, state);
    }
    return state;
}

function rejectEvent(event: NostrEvent, reason: string): ["OK", string, false, string] {
    return ["OK", event.id, false, reason];
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
            // raced with another reserve for the same event id
            return true;
        }
        return false;
    }
}

async function rollbackStorage(eventId: string): Promise<void> {
    await db.rollbackRelayEvent(eventId);
}

function validateEvent(event: NostrEvent): void {
    if (!verifyEvent(event)) {
        throw new Error("Invalid event signature");
    }
}

function closeClientSubscription(subId: string, state: RelaySocketState): void {
    const subscription = state.subscriptions.get(subId);
    if (!subscription) {
        return;
    }
    subscription.closed = true;
    for (const { relay, backendSubId } of subscription.backendSubs) {
        relayPool.closeSubscription(relay, backendSubId);
    }
    state.subscriptions.delete(subId);
}

wss.on("connection", (socket) => {
    const state = getAuthState(socket);
    const challenge = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    socket.send(JSON.stringify(["AUTH", challenge]));

    socket.on("message", async (raw) => {
        try {
            const payload = JSON.parse(raw.toString("utf8"));
            if (!Array.isArray(payload)) {
                return;
            }

            const [messageType, ...rest] = payload as unknown[];
            if (messageType === "AUTH") {
                const [authEvent] = rest as [NostrEvent];
                const pubkey = verifyNip42AuthEvent(authEvent, challenge, relayUrl);
                state.pubkey = pubkey;
                state.npub = getNpubFromPubkey(pubkey);
                socket.send(JSON.stringify(["OK", authEvent.id, true, ""]));
                return;
            }

            if (messageType === "EVENT") {
                const [event] = rest as [NostrEvent];
                validateEvent(event);

                if (!state.npub || !state.pubkey || event.pubkey !== state.pubkey) {
                    socket.send(JSON.stringify(rejectEvent(event, "auth-required: authentication required for writes")));
                    return;
                }

                if (event.kind === 5) {
                    const deletionTarget = event.tags.find((tag) => tag[0] === "e")?.[1];
                    if (!deletionTarget) {
                        socket.send(JSON.stringify(rejectEvent(event, "Deletion target missing")));
                        return;
                    }

                    const existing = await db.getRelayEvent(deletionTarget);
                    if (!existing || existing.npub !== state.npub) {
                        socket.send(JSON.stringify(rejectEvent(event, "Deletion not authorized")));
                        return;
                    }

                    const deletionEvent = { ...event, kind: 5 } as NostrEvent;
                    await relayPool.delete(deletionEvent, existing.replicas);
                    await db.deleteRelayEvent(existing.eventId);
                    socket.send(JSON.stringify(["OK", event.id, true, ""]));
                    return;
                }

                const npub = getNpubFromPubkey(event.pubkey);
                const user = await db.upsertUser(npub);

                const planConfig = (await getPlanConfig(db))[user.plan];
                const size = Buffer.byteLength(JSON.stringify(event), "utf8");
                if (size > planConfig.uploadLimit) {
                    socket.send(JSON.stringify(rejectEvent(event, "File exceeds upload limit")));
                    return;
                }

                const reserved = await reserveStorage(event, npub, size);
                if (!reserved) {
                    socket.send(JSON.stringify(rejectEvent(event, "Storage limit exceeded")));
                    return;
                }

                const healthyRelaysPromise = (async () => {
                    const healthyRelays = await relayPool.selectHealthyRelays(planConfig.replicaCount);
                    await relayPool.publish(event, healthyRelays);
                    await db.setRelayEventReplicas(event.id, healthyRelays);
                })();

                try {
                    await healthyRelaysPromise;
                    socket.send(JSON.stringify(["OK", event.id, true, ""]));
                } catch (publishError) {
                    await rollbackStorage(event.id);
                    const reason = publishError instanceof Error ? publishError.message : "Failed to publish to relays";
                    socket.send(JSON.stringify(rejectEvent(event, reason)));
                }
                return;
            }

            if (messageType === "REQ") {
                const [subId, ...filters] = rest as [string, ...Record<string, unknown>[]];
                const backendSubs: BackendSub[] = [];
                state.subscriptions.set(subId, { closed: false, backendSubs });
                const seen = new Set<string>();

                const handleEvent = (event: NostrEvent) => {
                    if (state.subscriptions.get(subId)?.closed) {
                        return;
                    }
                    if (!seen.has(event.id)) {
                        seen.add(event.id);
                        socket.send(JSON.stringify(["EVENT", subId, event]));
                    }
                };

                await relayPool.query(
                    filters,
                    handleEvent,
                    () => {
                        if (!state.subscriptions.get(subId)?.closed) {
                            socket.send(JSON.stringify(["EOSE", subId]));
                        }
                    },
                    undefined,
                    (relay, backendSubId) => backendSubs.push({ relay, backendSubId }),
                );
                return;
            }

            if (messageType === "CLOSE") {
                const [subId] = rest as [string];
                closeClientSubscription(subId, state);
                socket.send(JSON.stringify(["NOTICE", `CLOSED ${subId}`]));
                return;
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : "Internal server error";
            socket.send(JSON.stringify(["NOTICE", reason]));
        }
    });


    socket.on("close", () => {
        for (const subId of state.subscriptions.keys()) {
            closeClientSubscription(subId, state);
        }
        authState.delete(socket);
    });
});


server.listen(Number(PORT), () => {
    console.log(`Nostr relay listening on port ${PORT}`);
});
