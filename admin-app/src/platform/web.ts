/**
 * Web adapter — browser build.
 *
 * A thin RPC over the crypto worker, which owns the wasm instance and the
 * decrypted key. Every operation therefore runs against the same Rust code the
 * native build uses; only the transport differs.
 */
import type { WorkerMethod, WorkerReady, WorkerRequest, WorkerResponse } from "./protocol";
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

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const pending = new Map<number, Pending>();
let nextId = 0;
let worker: Worker | null = null;
/** Resolves when wasm has instantiated; rejects if it never will. */
let ready: Promise<void> | null = null;

function start(): Worker {
  if (worker) return worker;

  const created = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "admin-crypto",
  });

  ready = new Promise<void>((resolve, reject) => {
    created.addEventListener(
      "message",
      (event: MessageEvent<WorkerReady | WorkerResponse>) => {
        const data = event.data;
        if ("ready" in data) {
          if (data.ready) resolve();
          else reject(new Error(data.error));
          return;
        }

        const entry = pending.get(data.id);
        if (!entry) return;
        pending.delete(data.id);
        if (data.ok) entry.resolve(data.value);
        else entry.reject(new Error(data.error));
      },
    );

    created.addEventListener("error", () => {
      const failure = new Error("The crypto worker stopped unexpectedly");
      reject(failure);
      for (const entry of pending.values()) entry.reject(failure);
      pending.clear();
    });
  });

  worker = created;
  return created;
}

async function rpc<T>(
  method: WorkerMethod,
  args: WorkerRequest["args"],
): Promise<T> {
  const active = start();
  await ready;

  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    active.postMessage({ id, method, args } as WorkerRequest);
  });
}

export const client: AdminClient = {
  normalizeHostUrl: (url) => rpc<string>("normalizeHostUrl", [url]),
  canonicalNpub: (npub) => rpc<string>("canonicalNpub", [npub]),
  generateHostKey: (passphrase) =>
    rpc<GeneratedKey>("generateHostKey", [passphrase]),
  importNsec: (nsec, passphrase) =>
    rpc<GeneratedKey>("importNsec", [nsec, passphrase]),
  unlockHost: (input: UnlockInput) => rpc<UnlockResult>("unlockHost", [input]),
  lockHost: () => rpc<void>("lockHost", []),
  status: () => rpc<HostStatus>("status", []),
  me: () => rpc<Me>("me", []),
  roster: () => rpc<Roster>("roster", []),
  members: () => rpc<Member[]>("members", []),
  storages: () => rpc<Storage[]>("storages", []),
  generateInvite: () => rpc<string>("generateInvite", []),
  authorizeMember: (npub, role) =>
    rpc<void>("authorizeMember", [npub, role]),
  revokeMember: (npub) => rpc<void>("revokeMember", [npub]),
  linkStorage: (npub) => rpc<void>("linkStorage", [npub]),
  setStorageCapacity: (npub, declaredCapacityBytes) =>
    rpc<void>("setStorageCapacity", [npub, declaredCapacityBytes]),
  removeStorage: (npub) => rpc<void>("removeStorage", [npub]),
};
