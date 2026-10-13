import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserInfo } from "@orchestrator/db-client";
import { deriveAccess, parseLifecycleConfig } from "@orchestrator/lifecycle";
import { dueNotifications, formatBytes, moderationNotification } from "./notifications.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-01T00:00:00.000Z");
const config = parseLifecycleConfig({
  graceDays: 7,
  writeBlockedDays: 30,
  readBlockedDays: 30,
  notify: { expiryWarningDays: [14, 3, 1], quotaWarningPercent: [80, 100] },
});

function user(overrides: Partial<UserInfo> = {}): UserInfo {
  return {
    npub: "npub1test",
    planExpiresAt: new Date(NOW.getTime() + 20 * DAY).toISOString(),
    storageBytes: "1000",
    usedStorage: "100",
    createdAt: new Date(NOW.getTime() - DAY).toISOString(),
    ...overrides,
  };
}

function accessFor(u: UserInfo) {
  return deriveAccess(
    {
      planExpiresAt: u.planExpiresAt,
      storageBytes: u.storageBytes,
      usedStorage: u.usedStorage,
    },
    NOW,
    config,
  );
}

test("active user below every threshold gets no notifications", () => {
  const u = user();
  const due = dueNotifications(u, accessFor(u), config, NOW);
  assert.deepEqual(due, []);
});

test("expiry warnings fire at each configured threshold, not before", () => {
  const u = user({ planExpiresAt: new Date(NOW.getTime() + 2 * DAY).toISOString() });
  const due = dueNotifications(u, accessFor(u), config, NOW);
  const kinds = due.filter((n) => n.kind.startsWith("expiry_warning")).map((n) => n.kind);
  assert.deepEqual(kinds.sort(), ["expiry_warning_14", "expiry_warning_3"]);
});

test("quota warnings fire at 80 and 100 percent", () => {
  const u = user({ usedStorage: "850" });
  const due80 = dueNotifications(u, accessFor(u), config, NOW);
  assert.ok(due80.some((n) => n.kind === "quota_warning_80"));
  assert.ok(!due80.some((n) => n.kind === "quota_warning_100"));

  const full = user({ usedStorage: "1200" });
  const dueFull = dueNotifications(full, accessFor(full), config, NOW);
  assert.ok(dueFull.some((n) => n.kind === "quota_warning_80"));
  assert.ok(dueFull.some((n) => n.kind === "quota_warning_100"));
});

test("lifecycle transitions produce grace/write/read notifications", () => {
  const grace = user({ planExpiresAt: new Date(NOW.getTime() - 2 * DAY).toISOString() });
  assert.ok(dueNotifications(grace, accessFor(grace), config, NOW).some((n) => n.kind === "grace_entered"));

  const writeBlocked = user({ planExpiresAt: new Date(NOW.getTime() - 10 * DAY).toISOString() });
  assert.ok(
    dueNotifications(writeBlocked, accessFor(writeBlocked), config, NOW).some(
      (n) => n.kind === "write_blocked",
    ),
  );

  const readBlocked = user({ planExpiresAt: new Date(NOW.getTime() - 45 * DAY).toISOString() });
  const readDue = dueNotifications(readBlocked, accessFor(readBlocked), config, NOW);
  assert.ok(readDue.some((n) => n.kind === "read_blocked"));
  assert.ok(readDue.find((n) => n.kind === "read_blocked")!.body.includes("purge"));
});

test("unpaid users produce no notifications", () => {
  const u = user({ planExpiresAt: null, storageBytes: null });
  assert.deepEqual(dueNotifications(u, accessFor(u), config, NOW), []);
});

test("dedupe refs are stable across passes", () => {
  const u = user({ planExpiresAt: new Date(NOW.getTime() + 2 * DAY).toISOString() });
  const first = dueNotifications(u, accessFor(u), config, NOW);
  const second = dueNotifications(u, accessFor(u), config, NOW);
  assert.deepEqual(first.map((n) => n.ref), second.map((n) => n.ref));
});

test("formatBytes renders human units", () => {
  assert.equal(formatBytes("0"), "0 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1024 * 1024 * 500), "500 MB");
  assert.equal(formatBytes(null), "unlimited");
});

test("moderation notification carries the reason and appeal copy", () => {
  const notification = moderationNotification({ id: "mod-1", hash: "abc", reason: "copyright" });
  assert.equal(notification.kind, "moderation_deleted");
  assert.match(notification.body, /copyright/);
  assert.match(notification.body, /appeal/);
});
