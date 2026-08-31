import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { RelayRegistry } from "./relay.js";

const activeStorage = {
  npub: "npub-storage",
  tunnelIp: "10.44.0.8",
  blossomPort: 3000,
  relayPort: 7777,
};

test("RelayRegistry maps DB npubs and resolves legacy URLs", async () => {
  const registry = new RelayRegistry({
    listActiveStorages: async () => [activeStorage] as never,
  }, ["ws://fallback:7777"]);

  await registry.refresh();
  assert.deepEqual(registry.candidates(), [
    { id: "npub-storage", url: "ws://10.44.0.8:7777" },
  ]);
  for (const url of ["http://old", "https://old", "ws://old", "wss://old"]) {
    assert.equal(registry.resolve(url), url);
  }
});

test("RelayRegistry uses fallback only for an empty list and retains good state on failure", async () => {
  let fail = false;
  const registry = new RelayRegistry({
    listActiveStorages: async () => {
      if (fail) throw new Error("unavailable");
      return [activeStorage] as never;
    },
  }, ["ws://fallback:7777"]);

  await registry.refresh();
  fail = true;
  const errorLog = mock.method(console, "error", () => undefined);
  await registry.refresh();
  errorLog.mock.restore();
  assert.equal(registry.resolve("npub-storage"), "ws://10.44.0.8:7777");

  const emptyRegistry = new RelayRegistry({
    listActiveStorages: async () => [] as never,
  }, ["ws://fallback:7777"]);
  await emptyRegistry.refresh();
  assert.deepEqual(emptyRegistry.candidates(), [
    { id: "ws://fallback:7777", url: "ws://fallback:7777" },
  ]);
});
