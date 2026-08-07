/**
 * The port every target implements.
 *
 * Nothing above this file knows whether it is running in a Tauri WebView or a
 * browser tab. Both adapters delegate all crypto, NIP-98 signing and response
 * parsing to the same Rust crate (`crates/admin-core`); they differ only in how
 * they reach it and how they send HTTP.
 *
 * Every method rejects with an `Error` whose message is the operator-facing
 * string produced by Rust.
 */
export interface AdminClient {
  /** Validate and canonicalize a host base URL. Rejects non-HTTPS URLs. */
  normalizeHostUrl(url: string): Promise<string>;

  /** Generate a fresh Nostr key, returned NIP-49 encrypted. */
  generateHostKey(passphrase: string): Promise<GeneratedKey>;

  /**
   * Encrypt an existing plaintext `nsec` under a passphrase.
   *
   * The plaintext is passed straight through to Rust and is never persisted;
   * only the returned `ncryptsec` is suitable for storage.
   */
  importNsec(nsec: string, passphrase: string): Promise<GeneratedKey>;

  /** Decrypt a credential and bind it to a host for this session. */
  unlockHost(input: UnlockInput): Promise<UnlockResult>;

  /** Discard the decrypted key. Safe to call when already locked. */
  lockHost(): Promise<void>;

  status(): Promise<HostStatus>;
  generateInvite(): Promise<string>;
  addDevice(npub: string): Promise<void>;
  removeDevice(npub: string): Promise<void>;
}

export interface UnlockInput {
  hostUrl: string;
  ncryptsec: string;
  passphrase: string;
}

export interface UnlockResult {
  hostUrl: string;
  npub: string;
}

export interface GeneratedKey {
  ncryptsec: string;
  npub: string;
}

export interface Peer {
  npub: string;
  tunnelIp: string | null;
  connected: boolean;
  lastSeen: string | null;
}

export interface HostStatus {
  connectedCount: number;
  peers: Peer[];
}

/** The operations the UI can be busy with, used to scope spinners. */
export type BusyKind =
  | "unlock"
  | "status"
  | "invite"
  | "device"
  | "device-remove"
  | "profile";
