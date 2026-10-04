import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveAccess,
  parseLifecycleConfig,
  type LifecycleConfig,
} from "./state.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-01T00:00:00.000Z");
const config: LifecycleConfig = parseLifecycleConfig({
  graceDays: 7,
  writeBlockedDays: 30,
  readBlockedDays: 30,
  purgeEnabled: false,
});

function user(overrides: Partial<Parameters<typeof deriveAccess>[0]> = {}) {
  return {
    plan: "pro",
    planExpiresAt: new Date(NOW.getTime() + 10 * DAY),
    storageBytes: 1_000_000_000n,
    usedStorage: 100n,
    ...overrides,
  };
}

test("no expiry is UNPAID and cannot read or upload", () => {
  const access = deriveAccess(user({ plan: null, planExpiresAt: null }), NOW, config);
  assert.equal(access.status, "UNPAID");
  assert.equal(access.canUpload, false);
  assert.equal(access.canRead, false);
});

test("active plan within allowance allows everything", () => {
  const access = deriveAccess(user(), NOW, config);
  assert.equal(access.status, "ACTIVE");
  assert.equal(access.canUpload, true);
  assert.equal(access.canRead, true);
  assert.equal(access.canDelete, true);
});

test("active but over quota enters GRACE without uploads", () => {
  const access = deriveAccess(
    user({ storageBytes: 1_000n, usedStorage: 2_000n }),
    NOW,
    config,
  );
  assert.equal(access.status, "GRACE");
  assert.equal(access.reason, "grace_over_quota");
  assert.equal(access.canUpload, false);
  assert.equal(access.canRead, true);
  assert.equal(access.canDelete, true);
});

test("deleting under the allowance returns to ACTIVE", () => {
  const access = deriveAccess(
    user({ storageBytes: 1_000n, usedStorage: 1_000n }),
    NOW,
    config,
  );
  assert.equal(access.status, "ACTIVE");
});

test("expired plan enters GRACE for graceDays", () => {
  const expiry = new Date(NOW.getTime() - 2 * DAY);
  const access = deriveAccess(user({ planExpiresAt: expiry }), NOW, config);
  assert.equal(access.status, "GRACE");
  assert.equal(access.reason, "grace_expired_plan");
  assert.equal(access.graceUntil?.getTime(), expiry.getTime() + 7 * DAY);
});

test("grace elapsed enters WRITE_BLOCKED (reads still allowed)", () => {
  const expiry = new Date(NOW.getTime() - 8 * DAY);
  const access = deriveAccess(user({ planExpiresAt: expiry }), NOW, config);
  assert.equal(access.status, "WRITE_BLOCKED");
  assert.equal(access.canUpload, false);
  assert.equal(access.canRead, true);
  assert.equal(access.canDelete, true);
});

test("write-blocked window elapsed enters READ_BLOCKED (owner may delete)", () => {
  const expiry = new Date(NOW.getTime() - (7 + 31) * DAY);
  const access = deriveAccess(user({ planExpiresAt: expiry }), NOW, config);
  assert.equal(access.status, "READ_BLOCKED");
  assert.equal(access.canRead, false);
  assert.equal(access.canDelete, true);
  assert.ok(access.purgeAt);
});

test("after the read-blocked window the account is CLOSED", () => {
  const expiry = new Date(NOW.getTime() - (7 + 30 + 31) * DAY);
  const access = deriveAccess(user({ planExpiresAt: expiry }), NOW, config);
  assert.equal(access.status, "CLOSED");
  assert.equal(access.canDelete, false);
});

test("config parsing rejects malformed values and defaults sensibly", () => {
  assert.throws(() => parseLifecycleConfig({ graceDays: -1 }), /graceDays/);
  assert.throws(() => parseLifecycleConfig({ purgeEnabled: "yes" }), /purgeEnabled/);
  assert.throws(
    () => parseLifecycleConfig({ notify: { expiryWarningDays: [1, "two"] } }),
    /expiryWarningDays/,
  );

  const defaults = parseLifecycleConfig({});
  assert.equal(defaults.graceDays, 7);
  assert.equal(defaults.purgeEnabled, false);
  assert.deepEqual(defaults.notify.expiryWarningDays, [14, 3, 1]);
});

test("zero-length windows collapse straight through to CLOSED", () => {
  const tight = parseLifecycleConfig({
    graceDays: 1,
    writeBlockedDays: 0,
    readBlockedDays: 0,
  });
  const expiry = new Date(NOW.getTime() - 2 * DAY);
  const access = deriveAccess(user({ planExpiresAt: expiry }), NOW, tight);
  assert.equal(access.status, "CLOSED");
  assert.equal(access.purgeAt?.getTime(), expiry.getTime() + DAY);
});
