import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

export interface Signer {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<{
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig: string;
  }>;
}

declare global {
  interface Window {
    nostr?: Signer;
  }
}

export interface Identities {
  /** hex public key */
  pubkey: string;
  npub: string;
  /** Only for the local dev signer; NIP-07 has no local secret. */
  sk?: Uint8Array;
}

const DEV_NSEC_KEY = "blossom-dev-nsec";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function connectSigner(): Promise<Identities> {
  if (window.nostr) {
    const pubkey = await window.nostr.getPublicKey();
    return { pubkey, npub: nip19.npubEncode(pubkey) };
  }

  // No extension: generate/store a local key so the console is usable in
  // development. This never happens when a NIP-07 extension is present.
  const stored = localStorage.getItem(DEV_NSEC_KEY);
  let sk: Uint8Array;
  if (stored?.startsWith("nsec1")) {
    const decoded = nip19.decode(stored);
    if (decoded.type !== "nsec") throw new Error("bad stored dev key");
    sk = decoded.data;
  } else {
    sk = crypto.getRandomValues(new Uint8Array(32));
    localStorage.setItem(DEV_NSEC_KEY, nip19.nsecEncode(sk));
  }
  const pubkey = getPublicKey(sk);
  return { pubkey, npub: nip19.npubEncode(pubkey), sk };
}

/** BUD-11 kind-24242 authorization for Blossom protocol routes. */
export async function blossomAuth(
  identities: Identities,
  action: string,
  opts: { hash?: string; message?: string } = {},
): Promise<string> {
  const tags: string[][] = [["t", action]];
  if (opts.hash) tags.push(["x", opts?.hash]);
  tags.push(["expiration", String(Math.floor(Date.now() / 1000) + 300)]);

  const template: EventTemplate = {
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    content: opts.message ?? `${action} via Blossom console`,
    tags,
  };
  return sign(identities, template);
}

/** NIP-98 kind-27235 authorization bound to a URL/method/body. */
export async function nip98Auth(
  identities: Identities,
  url: string,
  method: string,
  body?: unknown,
): Promise<string> {
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];

  if (body !== undefined) {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    tags.push(["payload", [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")]);
  }

  const template: EventTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags,
  };
  return sign(identities, template);
}

async function sign(identities: Identities, template: EventTemplate): Promise<string> {
  if (!window.nostr && !identities.sk) {
    throw new Error("No signer available");
  }
  const signed = window.nostr
    ? await window.nostr.signEvent(template)
    : finalizeEvent(template, identities.sk!);
  const json = new TextEncoder().encode(JSON.stringify(signed));
  return `Nostr ${base64(json)}`;
}

export function shortNpub(npub: string): string {
  return `${npub.slice(0, 10)}…${npub.slice(-6)}`;
}
