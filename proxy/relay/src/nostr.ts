import { verifyEvent, type NostrEvent } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import type { Request } from "express";

const DEFAULT_PORTS: Record<string, number> = {
  "ws:": 80,
  "wss:": 443,
  "http:": 80,
  "https:": 443,
};

export type NormalizedRelayUrl = {
  protocol: "ws" | "wss";
  hostname: string;
  port: number;
  pathname: string;
};

export function normalizeRelayUrl(rawUrl: string): NormalizedRelayUrl {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("invalid: relay URL is not a valid URL");
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("invalid: relay URL must use ws or wss");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new Error("invalid: relay URL hostname is missing");
  }

  const defaultPort = DEFAULT_PORTS[parsed.protocol] ?? (parsed.protocol === "wss:" ? 443 : 80);
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : defaultPort;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("invalid: relay URL port is invalid");
  }

  let pathname = parsed.pathname || "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  return {
    protocol: parsed.protocol as "ws" | "wss",
    hostname,
    port,
    pathname,
  };
}

export function relayUrlsEquivalent(left: string, right: string): boolean {
  const a = normalizeRelayUrl(left);
  const b = normalizeRelayUrl(right);
  return (
    a.protocol === b.protocol &&
    a.hostname === b.hostname &&
    a.port === b.port &&
    a.pathname === b.pathname
  );
}

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
    throw new Error("invalid: event signature verification failed");
  }

  if (event.kind !== 22242) {
    throw new Error("invalid: auth event must be kind 22242");
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > 120) {
    throw new Error("invalid: auth event is expired");
  }

  const challengeTag = event.tags.find((t) => t[0] === "challenge")?.[1];
  const relayTag = event.tags.find((t) => t[0] === "relay")?.[1];

  if (challengeTag !== challenge) {
    throw new Error("invalid: auth challenge mismatch");
  }

  if (!relayTag) {
    throw new Error("invalid: auth event is missing relay tag");
  }

  try {
    if (!relayUrlsEquivalent(relayTag, relayUrl)) {
      throw new Error("invalid: auth relay URL mismatch");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid:")) {
      throw error;
    }
    throw new Error("invalid: auth relay URL mismatch");
  }

  return event.pubkey;
}

export function getNpub(event: NostrEvent): string {
  return npubEncode(event.pubkey);
}

export function getNpubFromPubkey(pubkey: string): string {
  return npubEncode(pubkey);
}
