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
    planExpiresAt: null as Date | null,
    storageBytes: null as bigint | null,
    usedStorage: 0n,
    ...overrides,
  };
}

function request(overrides: Partial<Parameters<typeof parseEntitlementRequest>[0]> = {}) {
  return parseEntitlementRequest({
    durationDays: 30,
    storageBytes: "500000000",
    source: "payment",
    mode: "extend",
    paymentHash: "a".repeat(64),
    ...overrides,
  });
}

test("first purchase sets expiry and allowance", () => {
  const effect = computeEntitlement(user(), request(), NOW);
  assert.equal(effect.storageBytes, 500000000n);
  assert.equal(effect.planExpiresAt.getTime(), NOW.getTime() + 30 * DAY);
});

test("extend adds days to the live expiry without changing the allowance", () => {
  const expiry = new Date(NOW.getTime() + 10 * DAY);
  const effect = computeEntitlement(
    user({ planExpiresAt: expiry, storageBytes: 2_000_000_000n }),
    request({ durationDays: 30, storageBytes: "2000000000", mode: "extend" }),
    NOW,
  );
  assert.equal(effect.storageBytes, 2_000_000_000n);
  assert.equal(effect.planExpiresAt.getTime(), expiry.getTime() + 30 * DAY);
});

test("extend from an expired plan adds days from now and applies the new allowance", () => {
  const effect = computeEntitlement(
    user({
      planExpiresAt: new Date(NOW.getTime() - 5 * DAY),
      storageBytes: 2_000_000_000n,
    }),
    request({ durationDays: 30, storageBytes: "500000000", mode: "extend" }),
    NOW,
  );
  assert.equal(effect.storageBytes, 500_000_000n);
  assert.equal(effect.planExpiresAt.getTime(), NOW.getTime() + 30 * DAY);
});

test("upgrade applies immediately and preserves remaining days", () => {
  const expiry = new Date(NOW.getTime() + 10 * DAY);
  const effect = computeEntitlement(
    user({ planExpiresAt: expiry, storageBytes: 500_000_000n }),
    request({ durationDays: 30, storageBytes: "2000000000", mode: "upgrade" }),
    NOW,
  );
  assert.equal(effect.storageBytes, 2_000_000_000n);
  assert.equal(effect.planExpiresAt.getTime(), expiry.getTime() + 30 * DAY);
});

test("downgrade after expiry applies the smaller allowance", () => {
  const effect = computeEntitlement(
    user({
      planExpiresAt: new Date(NOW.getTime() - DAY),
      storageBytes: 2_000_000_000n,
      usedStorage: 800_000_000n,
    }),
    request({ durationDays: 30, storageBytes: "500000000", mode: "extend" }),
    NOW,
  );
  assert.equal(effect.storageBytes, 500_000_000n);
});

test("renewal that leaves the user over quota keeps the allowance and sets a future expiry", () => {
  const expiry = new Date(NOW.getTime() + 10 * DAY);
  const effect = computeEntitlement(
    user({
      planExpiresAt: expiry,
      storageBytes: 2_000_000_000n,
      usedStorage: 2_500_000_000n,
    }),
    request({ durationDays: 30, storageBytes: "2000000000", mode: "extend" }),
    NOW,
  );
  assert.equal(effect.storageBytes, 2_000_000_000n);
  assert.equal(effect.planExpiresAt.getTime(), expiry.getTime() + 30 * DAY);
});

test("live plan without a mode is rejected", () => {
  assert.throws(
    () =>
      computeEntitlement(
        user({
          planExpiresAt: new Date(NOW.getTime() + DAY),
          storageBytes: 2_000_000_000n,
        }),
        request({ mode: undefined }),
        NOW,
      ),
    (error: unknown) => error instanceof EntitlementError && error.code === "mode_required",
  );
});

test("admin force can downgrade a live plan", () => {
  const effect = computeEntitlement(
    user({
      planExpiresAt: new Date(NOW.getTime() + DAY),
      storageBytes: 2_000_000_000n,
    }),
    request({ storageBytes: "500000000", source: "admin", mode: "extend", force: true }),
    NOW,
  );
  assert.equal(effect.storageBytes, 500_000_000n);
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

test("a payment grant must carry a payment hash", () => {
  assert.throws(
    () => parseEntitlementRequest({ durationDays: 30, storageBytes: "1", source: "payment", mode: "extend" }),
    (error) => error instanceof EntitlementError && error.code === "payment_hash_required",
  );
});

test("a malformed payment hash is rejected", () => {
  assert.throws(
    () => request({ paymentHash: "not-a-hash" }),
    (error) => error instanceof EntitlementError && error.code === "invalid_payment_hash",
  );
});

test("an admin grant needs no payment hash", () => {
  const parsed = parseEntitlementRequest({ durationDays: 30, storageBytes: "1", source: "admin" });
  assert.equal(parsed.paymentHash, undefined);
});
