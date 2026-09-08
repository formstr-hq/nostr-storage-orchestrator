import { nip19, finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type Event } from "nostr-tools";
import { encrypt as nip49Encrypt, decrypt as nip49Decrypt } from "nostr-tools/nip49";

interface SignerState {
  /** Decrypted secret key — memory only, cleared on lock / idle. */
  activeSecret: Uint8Array | null;
  activeNpub: string | null;
}

const state: SignerState = { activeSecret: null, activeNpub: null };
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** MV3 service workers suspend after ~30s idle; clear the key proactively. */
function scheduleIdleClear() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    state.activeSecret = null;
    state.activeNpub = null;
  }, 5 * 60 * 1000);
}

// ── profiles ─────────────────────────────────────────────────────────────────

export interface StoredProfile {
  /** NIP-49-encrypted secret key; only this string is ever persisted. */
  ncryptsec: string;
  npub: string;
  label: string;
  createdAt: number;
}

async function getProfiles(): Promise<StoredProfile[]> {
  const data = await chrome.storage.local.get("profiles");
  return (data["profiles"] as StoredProfile[] | undefined) ?? [];
}

export async function importKey(nsec: string, passphrase: string, label: string) {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") throw new Error("Not an nsec");
  const secret = decoded.data as Uint8Array;
  const ncryptsec = nip49Encrypt(secret, passphrase) as string;
  const npub = nip19.npubEncode(getPublicKey(secret));
  const profiles = await getProfiles();
  if (profiles.some((profile) => profile.npub === npub)) throw new Error("Key already imported");
  await chrome.storage.local.set({
    profiles: [
      ...profiles,
      { ncryptsec, npub, label: label || `Key ${profiles.length + 1}`, createdAt: Date.now() },
    ],
  });
  return { npub };
}

export async function generateKey(passphrase: string, label: string) {
  const secret = generateSecretKey();
  const ncryptsec = nip49Encrypt(secret, passphrase) as string;
  const npub = nip19.npubEncode(getPublicKey(secret));
  const profiles = await getProfiles();
  await chrome.storage.local.set({
    profiles: [
      ...profiles,
      { ncryptsec, npub, label: label || `Key ${profiles.length + 1}`, createdAt: Date.now() },
    ],
  });
  return { npub };
}

export async function removeProfile(npub: string) {
  const profiles = await getProfiles();
  await chrome.storage.local.set({ profiles: profiles.filter((profile) => profile.npub !== npub) });
  if (state.activeNpub === npub) lock();
}

// ── session (memory-only plaintext) ──────────────────────────────────────────

export async function unlock(npub: string, passphrase: string): Promise<{ ok: boolean; error?: string }> {
  const profiles = await getProfiles();
  const profile = profiles.find((candidate) => candidate.npub === npub);
  if (!profile) return { ok: false, error: "Unknown profile" };
  try {
    state.activeSecret = nip49Decrypt(profile.ncryptsec, passphrase);
    state.activeNpub = profile.npub;
    scheduleIdleClear();
    return { ok: true };
  } catch {
    return { ok: false, error: "Wrong passphrase" };
  }
}

export function lock(): { ok: true } {
  state.activeSecret = null;
  state.activeNpub = null;
  if (idleTimer) clearTimeout(idleTimer);
  return { ok: true };
}

export async function status() {
  const profiles = await getProfiles();
  return {
    unlocked: state.activeSecret !== null,
    activeNpub: state.activeNpub,
    profiles: profiles.map((profile) => ({ npub: profile.npub, label: profile.label, createdAt: profile.createdAt })),
  };
}

// ── per-site opt-in (deny-all by default) ────────────────────────────────────

export interface AllowlistEntry {
  origin: string;
  addedAt: number;
}

export async function getAllowlist(): Promise<AllowlistEntry[]> {
  const data = await chrome.storage.local.get("allowlist");
  return (data["allowlist"] as AllowlistEntry[] | undefined) ?? [];
}

export async function setOriginAllowed(origin: string, allowed: boolean) {
  const list = await getAllowlist();
  const next = allowed
    ? [...list.filter((entry) => entry.origin !== origin), { origin, addedAt: Date.now() }]
    : list.filter((entry) => entry.origin !== origin);
  await chrome.storage.local.set({ allowlist: next });
}

export async function isOriginAllowed(origin: string): Promise<boolean> {
  const list = await getAllowlist();
  return list.some((entry) => entry.origin === origin);
}

// ── signing (NIP-07 surface: getPublicKey + signEvent only) ───────────────────

export type SignResult = { ok: true; event: Event } | { ok: false; error: string };

export function getActivePublicKey(): { ok: true; pubkey: string } | { ok: false; error: string } {
  if (!state.activeSecret) return { ok: false, error: "Signer locked" };
  return { ok: true, pubkey: getPublicKey(state.activeSecret) };
}

export function signEvent(template: EventTemplate): SignResult {
  if (!state.activeSecret) return { ok: false, error: "Signer locked" };
  const pubkey = getPublicKey(state.activeSecret);
  // finalizeEvent derives the pubkey from the secret; no need to spread it.
  const event = finalizeEvent(template, state.activeSecret);
  return { ok: true, event };
}