import { verifyEvent, nip19 } from "nostr-tools";

export type BlossomAction = "get" | "upload" | "list" | "delete" | "media";

export class AuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

interface NostrAuthEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

function parseAuthHeader(authHeader: string): NostrAuthEvent {
  const encoded = authHeader.replace(/^Nostr\s+/i, "");

  let json: string;
  try {
    json = Buffer.from(encoded, "base64").toString("utf-8");
  } catch {
    throw new AuthError("Malformed Authorization header", 400);
  }

  try {
    return JSON.parse(json) as NostrAuthEvent;
  } catch {
    throw new AuthError("Malformed Authorization event", 400);
  }
}

/**
 * Validates a BUD-11 Nostr authorization token and returns the signer's npub.
 *
 * `hash`, when provided, is the sha256 this action targets. Per the BUD-11
 * endpoint table, `x` tag scoping is REQUIRED for upload/delete (the token
 * MUST carry a matching `x` tag) and OPTIONAL for get (a matching `x` tag is
 * only enforced if the token happens to carry one).
 */
export function verifyAuthToken(
  authHeader: string | undefined,
  action: BlossomAction,
  opts: { hash?: string | undefined; requireHashScope?: boolean } = {},
): string {
  if (!authHeader) {
    throw new AuthError("Missing Authorization header", 401);
  }

  const event = parseAuthHeader(authHeader);

  if (!verifyEvent(event)) {
    throw new AuthError("Invalid Nostr signature", 401);
  }

  if (event.kind !== 24242) {
    throw new AuthError("Authorization event must be kind 24242", 401);
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof event.created_at !== "number" || event.created_at > now) {
    throw new AuthError("Authorization event created_at must be in the past", 401);
  }

  const tags = Array.isArray(event.tags) ? event.tags : [];

  const expirationTag = tags.find((t) => t[0] === "expiration")?.[1];
  const expiration = expirationTag ? Number(expirationTag) : NaN;
  if (!expirationTag || !Number.isFinite(expiration) || expiration <= now) {
    throw new AuthError("Authorization event is missing a valid future expiration tag", 401);
  }

  const tTag = tags.find((t) => t[0] === "t")?.[1];
  if (tTag !== action) {
    throw new AuthError(`Authorization event must have a "t" tag of "${action}"`, 401);
  }

  if (opts.hash) {
    const xTags = tags.filter((t) => t[0] === "x").map((t) => t[1]?.toLowerCase());
    if (xTags.length > 0) {
      if (!xTags.includes(opts.hash.toLowerCase())) {
        throw new AuthError("Authorization event's \"x\" tag does not match the target blob hash", 401);
      }
    } else if (opts.requireHashScope) {
      throw new AuthError('Authorization event must include an "x" tag for the target blob hash', 401);
    }
  }

  return nip19.npubEncode(event.pubkey);
}
