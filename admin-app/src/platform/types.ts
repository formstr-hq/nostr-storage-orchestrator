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
  /** Validate and canonicalize a Nostr public key. */
  canonicalNpub(npub: string): Promise<string>;

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
  me(): Promise<Me>;
  roster(): Promise<Roster>;
  members(): Promise<Member[]>;
  storages(): Promise<Storage[]>;
  generateInvite(): Promise<string>;
  authorizeMember(npub: string, role: MemberRole): Promise<void>;
  revokeMember(npub: string): Promise<void>;
  linkStorage(npub: string): Promise<void>;
  setStorageCapacity(npub: string, declaredCapacityBytes: string): Promise<void>;
  removeStorage(npub: string): Promise<void>;
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

export type Role = "admin" | "client" | "none";
export type MemberRole = Exclude<Role, "none">;
export type MemberStatus = "active" | "revoked";
export type StorageLifecycle = "linked" | "removed";
export type StorageLiveness = "pending" | "active" | "unreachable";

export interface Me {
  npub: string;
  role: Role;
  memberSince: string | null;
}

export interface Roster {
  members: {
    authorized: number;
    admins: number;
    clients: number;
    revoked: number;
  };
  storages: {
    total: number;
    active: number;
    pending: number;
    unreachable: number;
    reportedTotalBytes: string;
    reportedFreeBytes: string;
  };
  replicaCountRequired: number;
  replicaShortfall: boolean;
}

export interface Member {
  npub: string;
  role: MemberRole;
  status: MemberStatus;
  storageCount: number;
  createdAt: string;
  updatedAt: string;
  addedByNpub: string | null;
}

export interface Storage {
  npub: string;
  ownerNpub: string;
  tunnelIp: string | null;
  blossomPort: number | null;
  relayPort: number | null;
  declaredCapacityBytes: string | null;
  reportedTotalBytes: string | null;
  reportedFreeBytes: string | null;
  lifecycle: StorageLifecycle;
  liveness: StorageLiveness;
  lastPingAt: string | null;
  createdAt: string;
}

/** The operations the UI can be busy with, used to scope spinners. */
export type BusyKind =
  | "unlock"
  | "refresh"
  | "invite"
  | "member-authorize"
  | "member-revoke"
  | "storage-link"
  | "storage-capacity"
  | "storage-remove"
  | "profile";
