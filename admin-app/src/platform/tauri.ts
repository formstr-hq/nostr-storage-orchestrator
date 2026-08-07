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
  generateHostKey: (passphrase) =>
    call<GeneratedKey>("generate_host_key", { passphrase }),
  importNsec: (nsec, passphrase) =>
    call<GeneratedKey>("import_nsec", { nsec, passphrase }),
  unlockHost: (input: UnlockInput) => call<UnlockResult>("unlock_host", { ...input }),
  lockHost: () => call<void>("lock_host"),
  status: () => call<HostStatus>("status"),
  generateInvite: () => call<string>("generate_invite"),
  addDevice: (npub) => call<void>("add_device", { npub }),
  removeDevice: (npub) => call<void>("remove_device", { npub }),
};
