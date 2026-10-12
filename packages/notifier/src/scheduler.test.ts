import assert from "node:assert/strict";
import { test } from "node:test";
import type { DbClient, UserInfo } from "@orchestrator/db-client";
import { parseLifecycleConfig } from "@orchestrator/lifecycle";
import { runOnce } from "./scheduler.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-01T00:00:00.000Z");

function config(purgeEnabled: boolean) {
  return parseLifecycleConfig({ graceDays: 7, writeBlockedDays: 30, readBlockedDays: 30, purgeEnabled });
}

function user(daysSinceExpiry: number, usedStorage = "500"): UserInfo {
  return {
    npub: "npub1purge",
    planExpiresAt: new Date(NOW.getTime() - daysSinceExpiry * DAY).toISOString(),
    storageBytes: "1000",
    usedStorage,
    createdAt: new Date(NOW.getTime() - 100 * DAY).toISOString(),
  };
}

async function pass(u: UserInfo, purgeEnabled: boolean) {
  const purged: string[] = [];
  const db = {
    listAttentionUsers: async () => ({ items: [u], total: 1, page: 1, pageSize: 100 }),
    logNotification: async () => true,
  } as unknown as DbClient;
  await runOnce({
    db,
    dm: null,
    email: { send: async () => "no_address" } as never,
    config: config(purgeEnabled),
    purge: async (npub) => {
      purged.push(npub);
      return { purged: 3 };
    },
    now: () => NOW,
  });
  return purged;
}

// grace 7 + write-blocked 30 + read-blocked 30 = 67 days after expiry.
test("an account past the retention window (CLOSED) is purged", async () => {
  assert.deepEqual(await pass(user(70), true), ["npub1purge"]);
});

test("an account still inside the retention window is not purged", async () => {
  assert.deepEqual(await pass(user(50), true), []);
});

test("nothing is purged while purgeEnabled is false", async () => {
  assert.deepEqual(await pass(user(70), false), []);
});

test("a closed account with nothing stored is not purged again", async () => {
  assert.deepEqual(await pass(user(70, "0"), true), []);
});
