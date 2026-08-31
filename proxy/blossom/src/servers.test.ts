import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ServerRegistry } from "./servers.js";

const activeStorage = {
  npub: "npub-storage",
  tunnelIp: "10.44.0.8",
  blossomPort: 3000,
  relayPort: 7777,
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
