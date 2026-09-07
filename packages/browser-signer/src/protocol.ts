/**
 * RPC contract between the UI/content-script contexts and the service worker.
 * Every request carries a unique id; responses carry the same id.
 */
export type WorkerRequest =
  | { type: "status" }
  | { type: "unlock"; npub: string; passphrase: string }
  | { type: "lock" }
  | { type: "importKey"; nsec: string; passphrase: string; label: string }
  | { type: "generateKey"; passphrase: string; label: string }
  | { type: "removeProfile"; npub: string }
  | { type: "allowlist" }
  | { type: "setOriginAllowed"; origin: string; allowed: boolean };

export type WorkerResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export const WORKER_MSG = "formstr-signer-request";
export const RESPONSE_MSG = "formstr-signer-response";