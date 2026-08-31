/**
 * Tauri adapter — Linux, Android, Windows, macOS.
 *
 * Every method is a direct `invoke` of the matching command in
 * `src-tauri/src/lib.rs`. The decrypted key lives in the Rust process and never
 * crosses the IPC boundary, and Rust performs the HTTP itself with redirects
 * refused.
 */
import { invoke } from "@tauri-apps/api/core";

import type {
  AdminClient,
  GeneratedKey,
  HostStatus,
  Me,
  Member,
  Roster,
  Storage,
  UnlockInput,
  UnlockResult,
} from "./types";

/** Tauri rejects commands with the plain `String` the command returned. */
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((error: unknown) => {
    throw new Error(
      typeof error === "string" ? error : "The operation could not be completed",
    );
  });
}

export const client: AdminClient = {
  normalizeHostUrl: (url) => call<string>("normalize_host_url", { url }),
  canonicalNpub: (npub) => call<string>("canonical_npub", { npub }),
  generateHostKey: (passphrase) =>
    call<GeneratedKey>("generate_host_key", { passphrase }),
  importNsec: (nsec, passphrase) =>
    call<GeneratedKey>("import_nsec", { nsec, passphrase }),
  unlockHost: (input: UnlockInput) => call<UnlockResult>("unlock_host", { ...input }),
  lockHost: () => call<void>("lock_host"),
  status: () => call<HostStatus>("status"),
  me: () => call<Me>("me"),
  roster: () => call<Roster>("roster"),
  members: () => call<Member[]>("members"),
  storages: () => call<Storage[]>("storages"),
  generateInvite: () => call<string>("generate_invite"),
  authorizeMember: (npub, role) =>
    call<void>("authorize_member", { npub, role }),
  revokeMember: (npub) => call<void>("revoke_member", { npub }),
  linkStorage: (npub) => call<void>("link_storage", { npub }),
  setStorageCapacity: (npub, declaredCapacityBytes) =>
    call<void>("set_storage_capacity", { npub, declaredCapacityBytes }),
  removeStorage: (npub) => call<void>("remove_storage", { npub }),
};
