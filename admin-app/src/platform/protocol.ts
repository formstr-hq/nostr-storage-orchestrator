/**
 * Message shapes exchanged with the crypto worker in the web build.
 *
 * Derived from `AdminClient` so the worker and its caller cannot drift: adding
 * a method to the port is immediately a type error on both sides.
 */
import type { AdminClient } from "./types";

type Signatures = {
  [K in keyof AdminClient]: AdminClient[K] extends (
    ...args: infer A
  ) => Promise<infer R>
    ? { args: A; result: R }
    : never;
};

export type WorkerMethod = keyof Signatures;

export type WorkerRequest = {
  [K in WorkerMethod]: { id: number; method: K; args: Signatures[K]["args"] };
}[WorkerMethod];

export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

/** Signals the worker finished instantiating wasm, or failed to. */
export type WorkerReady = { ready: true } | { ready: false; error: string };
