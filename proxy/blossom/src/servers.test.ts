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

test("selectOwner is deterministic and independent of candidate order", () => {
  // FNV-1a mod 3: "npub-bob" = 0, "npub-alice" = 2.
  assert.equal(selectOwner("npub-bob", candidates)?.id, "npub-alice");
  assert.equal(selectOwner("npub-alice", candidates)?.id, "npub-carol");
  assert.equal(selectOwner("npub-alice", [...candidates].reverse())?.id, "npub-carol");
});

test("uploadBlob stores on the pk-selected provider and fails over by recomputing pk % n", async () => {
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
    // npub-alice picks npub-carol (10.44.0.3); after dropping it, 3 -> 2
    // recomputes fnv1a mod 2 = 1 over the remaining sorted pair: npub-bob.
    const result = await uploadBlob(Buffer.from("blob"), "hash", "Nostr token", "npub-alice", registry);
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
      uploadBlob(Buffer.from("blob"), "hash", "Nostr token", "npub-bob", { candidates: () => [...candidates] }),
      /Failed to upload blob to any storage provider/,
    );
    assert.equal(put.mock.callCount(), 3);
    await assert.rejects(
      uploadBlob(Buffer.from("blob"), "hash", "Nostr token", "npub-bob", { candidates: () => [] }),
      /No storage providers available/,
    );
  } finally {
    put.mock.restore();
    error.mock.restore();
  }
});
