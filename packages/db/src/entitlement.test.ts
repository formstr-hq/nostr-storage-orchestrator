import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EntitlementError,
  computeEntitlement,
  parseEntitlementRequest,
} from "./entitlement.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-01T00:00:00.000Z");

function user(overrides: Partial<Parameters<typeof computeEntitlement>[0]> = {}) {
  return {
    plan: null as string | null,
    planExpiresAt: null as Date | null,
    storageBytes: null as bigint | null,
    usedStorage: 0n,
    termsVersion: null as string | null,
    ...overrides,
  };
}

function request(overrides: Partial<Parameters<typeof parseEntitlementRequest>[0]> = {}) {
  return parseEntitlementRequest({
    plan: "basic",
    durationDays: 30,
    storageBytes: "500000000",
    source: "payment",
    mode: "extend",
    ...overrides,
  });
}

test("first purchase sets plan, expiry, allowance and terms", () => {
  const effect = computeEntitlement(
    user({ termsVersion: null }),
    request({ termsVersion: "2026-10-01" }),
    NOW,
  );
  assert.equal(effect.plan, "basic");
  assert.equal(effect.storageBytes, 500000000n);
  assert.equal(effect.planExpiresAt.getTime(), NOW.getTime() + 30 * DAY);
  assert.equal(effect.status, "ACTIVE");
  assert.equal(effect.termsVersion, "2026-10-01");
});

test("extend adds days to the live expiry without changing plan", () => {
  const expiry = new Date(NOW.getTime() + 10 * DAY);
  const effect = computeEntitlement(
    user({ plan: "pro", planExpiresAt: expiry, storageBytes: 2_000_000_000n }),
    request({ plan: "pro", durationDays: 30, storageBytes: "2000000000", mode: "extend" }),
    NOW,
  );
  assert.equal(effect.plan, "pro");
  assert.equal(effect.storageBytes, 2_000_000_000n);
  assert.equal(effect.planExpiresAt.getTime(), expiry.getTime() + 30 * DAY);
});

test("extend from an expired plan adds days from now and swaps the plan", () => {
  const effect = computeEntitlement(
    user({
      plan: "pro",
      planExpiresAt: new Date(NOW.getTime() - 5 * DAY),
      storageBytes: 2_000_000_000n,
    }),
    request({ plan: "basic", durationDays: 30, storageBytes: "500000000", mode: "extend" }),
    NOW,
  );
  assert.equal(effect.plan, "basic");
  assert.equal(effect.storageBytes, 500_000_000n);
  assert.equal(effect.planExpiresAt.getTime(), NOW.getTime() + 30 * DAY);
});

test("upgrade applies immediately and preserves remaining days", () => {
  const expiry = new Date(NOW.getTime() + 10 * DAY);
  const effect = computeEntitlement(
    user({ plan: "basic", planExpiresAt: expiry, storageBytes: 500_000_000n }),
    request({ plan: "pro", durationDays: 30, storageBytes: "2000000000", mode: "upgrade" }),
    NOW,
  );
  assert.equal(effect.plan, "pro");
  assert.equal(effect.storageBytes, 2_000_000_000n);
  assert.equal(effect.planExpiresAt.getTime(), expiry.getTime() + 30 * DAY);
});

test("downgrade after expiry with data over the new allowance enters GRACE", () => {
  const effect = computeEntitlement(
    user({
      plan: "pro",
      planExpiresAt: new Date(NOW.getTime() - DAY),
      storageBytes: 2_000_000_000n,
      usedStorage: 800_000_000n,
    }),
    request({ plan: "basic", durationDays: 30, storageBytes: "500000000", mode: "extend" }),
    NOW,
  );
  assert.equal(effect.plan, "basic");
  assert.equal(effect.status, "GRACE");
});

test("renewal that leaves the user over quota enters GRACE", () => {
  const expiry = new Date(NOW.getTime() + 10 * DAY);
  const effect = computeEntitlement(
    user({
      plan: "pro",
      planExpiresAt: expiry,
      storageBytes: 2_000_000_000n,
      usedStorage: 2_500_000_000n,
    }),
    request({ plan: "pro", durationDays: 30, storageBytes: "2000000000", mode: "extend" }),
    NOW,
  );
  assert.equal(effect.status, "GRACE");
});

test("live plan without a mode is rejected", () => {
  assert.throws(
    () =>
      computeEntitlement(
        user({
          plan: "pro",
          planExpiresAt: new Date(NOW.getTime() + DAY),
          storageBytes: 2_000_000_000n,
        }),
        request({ plan: "pro", mode: undefined }),
        NOW,
      ),
    (error: unknown) => error instanceof EntitlementError && error.code === "mode_required",
  );
});

test("admin force can downgrade a live plan", () => {
  const effect = computeEntitlement(
    user({
      plan: "pro",
      planExpiresAt: new Date(NOW.getTime() + DAY),
      storageBytes: 2_000_000_000n,
    }),
    request({ plan: "basic", storageBytes: "500000000", source: "admin", mode: "extend", force: true }),
    NOW,
  );
  assert.equal(effect.plan, "basic");
});

test("request parsing rejects bad input", () => {
  assert.throws(() => request({ durationDays: 0 }), /invalid_duration/);
  assert.throws(() => request({ storageBytes: "-1" }), /invalid_storage_bytes/);
  assert.throws(() => request({ source: "hacker" as never }), /invalid_source/);
  assert.throws(() => request({ mode: "downgrade" as never }), /invalid_mode/);
  assert.throws(
    () => request({ source: "payment", force: true }),
    /force_requires_admin/,
  );
});
