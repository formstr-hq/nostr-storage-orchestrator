import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { prisma } from "@orchestrator/db";
import { PLAN_CONFIG } from "./plan.js";
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
const relayUrl = process.env.PUBLIC_URL ?? `ws://localhost:${process.env.PORT ?? 8007}`;
const authState = new Map<WebSocket, RelaySocketState>();

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
        await prisma.$transaction(async (tx) => {
            const existing = await tx.relayEvent.findUnique({ where: { eventId: event.id } });
            if (existing) {
                return;
            }

            const user = await tx.user.findUniqueOrThrow({ where: { npub } });
            if (Number(user.usedStorage) + size > PLAN_CONFIG[user.plan].storageLimit) {
                throw new Error("Storage limit exceeded");
            }

            await tx.relayEvent.create({
                data: {
                    eventId: event.id,
                    npub,
                    kind: event.kind,
                    size,
                    replicas: [],
                },
            });
            await tx.user.update({
                where: { npub },
                data: { usedStorage: { increment: size } },
            });
        });
        return true;
    } catch {
        return false;
    }
}

async function rollbackStorage(eventId: string, npub: string, size: number): Promise<void> {
    await prisma.$transaction(async (tx) => {
        const existing = await tx.relayEvent.findUnique({ where: { eventId } });
        if (!existing) {
            return;
        }
        await tx.relayEvent.delete({ where: { eventId } });
        await tx.user.update({
            where: { npub },
            data: { usedStorage: { decrement: size } },
        });
    });
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

                    const existing = await prisma.relayEvent.findUnique({ where: { eventId: deletionTarget } });
                    if (!existing || existing.npub !== state.npub) {
                        socket.send(JSON.stringify(rejectEvent(event, "Deletion not authorized")));
                        return;
                    }

                    const deletionEvent = { ...event, kind: 5 } as NostrEvent;
                    await relayPool.delete(deletionEvent, existing.replicas);
                    await prisma.relayEvent.delete({ where: { eventId: existing.eventId } });
                    socket.send(JSON.stringify(["OK", event.id, true, ""]));
                    return;
                }

                const npub = getNpubFromPubkey(event.pubkey);
                const user = await prisma.user.upsert({
                    where: { npub },
                    update: {},
                    create: { npub: state.npub },
                });

                const planConfig = PLAN_CONFIG[user.plan];
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
                    await prisma.relayEvent.update({
                        where: { eventId: event.id },
                        data: { replicas: healthyRelays },
                    });
                })();

                try {
                    await healthyRelaysPromise;
                    socket.send(JSON.stringify(["OK", event.id, true, ""]));
                } catch (publishError) {
                    await rollbackStorage(event.id, npub, size);
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


const port = Number(process.env.PORT ?? 8007);
server.listen(port, () => {
    console.log(`Nostr relay listening on port ${port}`);
});