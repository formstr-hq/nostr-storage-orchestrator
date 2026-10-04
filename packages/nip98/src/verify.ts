import { createHash } from "node:crypto";
import { verifyEvent } from "nostr-tools";
import { nip19 } from "nostr-tools";
import { sha256Hex } from "./index.js";

export class Nip98Error extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "Nip98Error";
    this.status = status;
  }
}

interface Nip98Event {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface Nip98RequestLike {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  originalUrl: string;
  protocol: string;
  get(name: string): string | undefined;
  body?: unknown;
}

export interface VerifyOptions {
  /** Explicitly accepted URL, for callers whose public URL differs from Host. */
  expectedUrl?: string;
  /** Max clock skew in seconds. Default 300 (the NIP-98 suggestion). */
  maxSkewSeconds?: number;
  /** Replay cache; defaults to a process-local map. */
  replay?: ReplayCache;
}

export interface ReplayCache {
  /** Returns false when the event id was already seen. */
  remember(id: string, atSeconds: number): boolean;
}

const DEFAULT_SKEW = 300;

/** Process-local replay cache. Single-instance only; see the proxy notes. */
export function createInMemoryReplayCache(): ReplayCache {
  const seen = new Map<string, number>();
  return {
    remember(id, now) {
      for (const [key, at] of seen) {
        if (now - at > DEFAULT_SKEW * 2) seen.delete(key);
      }
      if (seen.has(id)) return false;
      seen.set(id, now);
      return true;
    },
  };
}

const defaultReplay = createInMemoryReplayCache();

/**
 * Verifies a NIP-98 (kind 27235) Authorization header against the exact
 * method/URL, the payload hash, and a short timestamp window, returning the
 * signer's pubkey (hex) and npub. Replay protection uses the event id.
 */
export function verifyNip98(
  req: Nip98RequestLike,
  options: VerifyOptions = {},
): { pubkey: string; npub: string } {
  const header = req.headers["authorization"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) {
    throw new Nip98Error("Missing Authorization header", 401);
  }

  const encoded = raw.replace(/^Nostr\s+/i, "");
  let event: Nip98Event;
  try {
    event = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")) as Nip98Event;
  } catch {
    throw new Nip98Error("Malformed Authorization header", 400);
  }

  if (!verifyEvent(event)) {
    throw new Nip98Error("Invalid Nostr signature", 401);
  }
  if (event.kind !== 27235) {
    throw new Nip98Error("Authorization event must be kind 27235", 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const skew = options.maxSkewSeconds ?? DEFAULT_SKEW;
  if (typeof event.created_at !== "number" || Math.abs(now - event.created_at) > skew) {
    throw new Nip98Error("Authorization event timestamp outside the accepted window", 401);
  }

  const tags = Array.isArray(event.tags) ? event.tags : [];
  const uTag = tags.find((t) => t[0] === "u")?.[1];
  const methodTag = tags.find((t) => t[0] === "method")?.[1]?.toUpperCase();

  if (!uTag || methodTag !== req.method.toUpperCase()) {
    throw new Nip98Error("Authorization event must carry matching u and method tags", 401);
  }

  // The signed URL must equal the URL the request actually arrived on.
  // `expectedUrl` is only for an explicitly configured public base (e.g. when
  // a reverse proxy rewrites Host); no host-swapping is accepted.
  const host = req.get("host");
  const derivedUrl = `${req.protocol}://${host}${req.originalUrl}`;
  const normalized = (value: string) => value.replace(/\/+$/, "");
  const matches =
    normalized(derivedUrl) === normalized(uTag) ||
    (options.expectedUrl !== undefined && normalized(options.expectedUrl) === normalized(uTag));
  if (!matches) {
    throw new Nip98Error("Authorization event URL does not match the request", 401);
  }

  const payloadTag = tags.find((t) => t[0] === "payload")?.[1];
  if (payloadTag) {
    const body = req.body;
    let payloadHash: string;
    if (Buffer.isBuffer(body)) {
      payloadHash = createHash("sha256").update(body).digest("hex");
    } else if (body === undefined || body === null) {
      payloadHash = sha256Hex("");
    } else {
      payloadHash = sha256Hex(JSON.stringify(body));
    }
    if (payloadHash !== payloadTag.toLowerCase()) {
      throw new Nip98Error("Authorization event payload hash does not match the request body", 401);
    }
  }

  const replay = options.replay ?? defaultReplay;
  if (!replay.remember(event.id, now)) {
    throw new Nip98Error("Authorization event has already been used", 401);
  }

  return { pubkey: event.pubkey, npub: nip19.npubEncode(event.pubkey) };
}
