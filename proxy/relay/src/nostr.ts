import { verifyEvent, type NostrEvent } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import type { Request } from "express";

export function verifyNip98(event: NostrEvent, req: Request): void {
    if (!verifyEvent(event)) {
        throw new Error("Invalid signature");
    }

    if (event.kind !== 27235) {
        throw new Error("Invalid kind");
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - event.created_at) > 60) {
        throw new Error("Expired auth event");
    }

    const method = event.tags.find((t) => t[0] === "method")?.[1];
    if (method !== req.method) {
        throw new Error("Method mismatch");
    }

    const url = event.tags.find((t) => t[0] === "u")?.[1];
    if (url !== `${process.env.PUBLIC_URL}${req.path}`) {
        throw new Error("URL mismatch");
    }
}

// Optional but recommended: bind the auth event to the actual bytes uploaded
export function verifyPayloadHash(event: NostrEvent, bodyHashHex: string): void {
    const payloadTag = event.tags.find((t) => t[0] === "payload")?.[1];
    if (payloadTag !== bodyHashHex) {
        throw new Error("Payload hash mismatch");
    }
}

export function parseAuthEvent(authHeader: string): NostrEvent {
    if (!authHeader?.startsWith("Nostr ")) {
        throw new Error("Missing Nostr authorization");
    }
    const encoded = authHeader.slice("Nostr ".length);
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

export function verifyNip42AuthEvent(event: NostrEvent, challenge: string, relayUrl: string): string {
    if (!verifyEvent(event)) {
        throw new Error("Invalid signature");
    }

    if (event.kind !== 22242) {
        throw new Error("Invalid auth kind");
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - event.created_at) > 120) {
        throw new Error("Expired auth event");
    }

    const challengeTag = event.tags.find((t) => t[0] === "challenge")?.[1];
    const relayTag = event.tags.find((t) => t[0] === "relay")?.[1];

    if (challengeTag !== challenge) {
        throw new Error("Challenge mismatch");
    }

    if (relayTag !== relayUrl) {
        throw new Error("Relay mismatch");
    }

    return event.pubkey;
}

export function getNpub(event: NostrEvent): string {
    return npubEncode(event.pubkey);
}

export function getNpubFromPubkey(pubkey: string): string {
    return npubEncode(pubkey);
}