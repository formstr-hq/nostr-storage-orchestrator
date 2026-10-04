import { createHash, randomBytes } from "node:crypto";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

/**
 * Decodes a bech32 nsec or 64-char hex secret key. Throws on anything else,
 * so a misconfigured service account fails at startup rather than silently
 * sending unsigned requests.
 */
export function decodeSecretKey(secret: string): Uint8Array {
  if (secret.startsWith("nsec1")) {
    const decoded = nip19.decode(secret);
    if (decoded.type !== "nsec") {
      throw new Error("not an nsec");
    }
    return decoded.data;
  }
  if (/^[0-9a-f]{64}$/i.test(secret)) {
    return Uint8Array.from(Buffer.from(secret, "hex"));
  }
  throw new Error("secret key must be a bech32 nsec or 64-char hex");
}

export function publicKeyOf(secret: string): { pubkey: string; npub: string } {
  const pubkey = getPublicKey(decodeSecretKey(secret));
  return { pubkey, npub: nip19.npubEncode(pubkey) };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export interface Nip98Signer {
  pubkey: string;
  npub: string;
  /** Signs a NIP-98 (kind 27235) Authorization header for one request. */
  header(method: string, url: string, body?: unknown): string;
}

/**
 * Service-account NIP-98 signer. Each internal caller has its own nsec; the
 * target service gates on the resulting npub's role, never on a shared secret.
 *
 * When `body` is given the signer must hash the exact JSON string it will put
 * on the wire, so callers should pass the same object they serialize (the
 * verifier recomputes over the raw body it received).
 */
export function createNip98Signer(secret: string): Nip98Signer {
  const sk = decodeSecretKey(secret);
  const { pubkey, npub } = publicKeyOf(secret);

  return {
    pubkey,
    npub,
    header(method, url, body) {
      const tags: string[][] = [
        ["u", url],
        ["method", method.toUpperCase()],
        // A random nonce makes each signed event unique. Replay protection is
        // keyed on the event id, so without this two byte-identical requests
        // inside the same second would be rejected as replays.
        ["nonce", randomHex(16)],
      ];
      if (body !== undefined) {
        tags.push(["payload", sha256Hex(JSON.stringify(body))]);
      }
      const event = finalizeEvent(
        {
          kind: 27235,
          created_at: Math.floor(Date.now() / 1000),
          content: "",
          tags,
        } satisfies EventTemplate,
        sk,
      );
      return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
    },
  };
}

export { verifyNip98, Nip98Error, createInMemoryReplayCache } from "./verify.js";
export type { Nip98RequestLike, VerifyOptions, ReplayCache } from "./verify.js";
