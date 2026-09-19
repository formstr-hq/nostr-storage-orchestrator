import assert from "node:assert/strict";
import { mock, test } from "node:test";
import axios from "axios";
import { ServerRegistry, selectOwner, uploadBlob } from "./servers.js";

const activeStorage = {
  npub: "npub-storage",
  tunnelIp: "10.44.0.8",
  blossomPort: 3000,
};

test("ServerRegistry maps DB npubs and resolves legacy URLs", async () => {
  const registry = new ServerRegistry({
    listActiveStorages: async () => [activeStorage] as never,
  }, ["http://fallback:3000"]);

  await registry.refresh();
  assert.deepEqual(registry.candidates(), [
    { id: "npub-storage", url: "http://10.44.0.8:3000" },
  ]);
  for (const url of ["http://old", "https://old", "ws://old", "wss://old"]) {
    assert.equal(registry.resolve(url), url);
  }
});

test("ServerRegistry uses fallback only for an empty list and retains good state on failure", async () => {
  let fail = false;
  const registry = new ServerRegistry({
    listActiveStorages: async () => {
      if (fail) throw new Error("unavailable");
      return [activeStorage] as never;
    },
  }, ["http://fallback:3000"]);

  await registry.refresh();
  fail = true;
  const errorLog = mock.method(console, "error", () => undefined);
  await registry.refresh();
  errorLog.mock.restore();
  assert.equal(registry.resolve("npub-storage"), "http://10.44.0.8:3000");

  const emptyRegistry = new ServerRegistry({
    listActiveStorages: async () => [] as never,
  }, ["http://fallback:3000"]);
  await emptyRegistry.refresh();
  assert.deepEqual(emptyRegistry.candidates(), [
    { id: "http://fallback:3000", url: "http://fallback:3000" },
  ]);
});

const candidates = [
  { id: "npub-carol", url: "http://10.44.0.3:3000" },
  { id: "npub-alice", url: "http://10.44.0.1:3000" },
  { id: "npub-bob", url: "http://10.44.0.2:3000" },
];

test("selectOwner is deterministic, time-seeded, and independent of candidate order", () => {
  // Fixed clock: fnv1a("npub:slot") mod 3 over [alice, bob, carol]:
  // slot 472222 -> alice, bob; slot 472227 -> alice -> carol.
  const first = 472222 * 3_600_000;
  const later = 472227 * 3_600_000;
  assert.equal(selectOwner("npub-alice", candidates, first)?.id, "npub-alice");
  assert.equal(selectOwner("npub-bob", candidates, first)?.id, "npub-bob");
  assert.equal(selectOwner("npub-alice", [...candidates].reverse(), first)?.id, "npub-alice");
  assert.equal(selectOwner("npub-alice", candidates, later)?.id, "npub-carol");
});

test("uploadBlob stores on the pk+time-selected provider and fails over by recomputing the selection", async () => {
  const now = 472227 * 3_600_000;
  const put = mock.method(axios, "put", async (url: string) => {
    if (url.startsWith("http://10.44.0.3:3000")) {
      throw new Error("provider down");
    }
    return { status: 200 };
  });
  const warn = mock.method(console, "warn", () => undefined);
  const error = mock.method(console, "error", () => undefined);
  const registry = { candidates: () => [...candidates] };

  try {
    // npub-alice picks npub-carol (10.44.0.3) at this slot; after dropping it,
    // the 3 -> 2 recompute over the sorted pair picks npub-bob (10.44.0.2).
    const result = await uploadBlob(Buffer.from("blob"), "hash", "Nostr token", "npub-alice", registry, now);
    assert.deepEqual(result, { hash: "hash", replicas: ["npub-bob"] });
    assert.deepEqual(put.mock.calls.map((call) => call.arguments[0]), [
      "http://10.44.0.3:3000/upload",
      "http://10.44.0.2:3000/upload",
    ]);
    assert.equal(warn.mock.callCount(), 1);
  } finally {
    put.mock.restore();
    warn.mock.restore();
    error.mock.restore();
  }
});

test("uploadBlob throws when no provider accepts and when the roster is empty", async () => {
  const put = mock.method(axios, "put", async () => {
    throw new Error("provider down");
  });
  const error = mock.method(console, "error", () => undefined);

  try {
    await assert.rejects(
      uploadBlob(Buffer.from("blob"), "hash", "Nostr token", "npub-bob", { candidates: () => [...candidates] }, 0),
      /Failed to upload blob to any storage provider/,
    );
    assert.equal(put.mock.callCount(), 3);
    await assert.rejects(
      uploadBlob(Buffer.from("blob"), "hash", "Nostr token", "npub-bob", { candidates: () => [] }, 0),
      /No storage providers available/,
    );
  } finally {
    put.mock.restore();
    error.mock.restore();
  }
});
