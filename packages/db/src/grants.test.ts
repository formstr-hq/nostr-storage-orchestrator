import assert from "node:assert/strict";
import { test } from "node:test";
import { nip19 } from "nostr-tools";
import {
  GrantError,
  parseAddGrantRequest,
  parseLegacyEntitlement,
  parseTransferRequest,
  summarizeGrants,
  workspaceSeatOwner,
} from "./grants.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-21T12:00:00.000Z");

function grant(startsAt: Date, expiresAt: Date, storageBytes: bigint) {
  return { startsAt, expiresAt, storageBytes };
}

test("active allowance is the sum of grants live at that instant", () => {
  const summary = summarizeGrants(
    [
      grant(new Date(NOW.getTime() - 10 * DAY), new Date(NOW.getTime() + 355 * DAY), 500n),
      grant(new Date(NOW.getTime() - 2 * DAY), new Date(NOW.getTime() + 28 * DAY), 5_000n),
    ],
    NOW,
  );
  assert.equal(summary.activeStorageBytes, 5_500n);
  assert.equal(summary.activeCount, 2);
});

test("an expired grant stops contributing but remains the lifecycle anchor", () => {
  const expired = new Date(NOW.getTime() - DAY);
  const summary = summarizeGrants(
    [
      grant(new Date(NOW.getTime() - 30 * DAY), expired, 5_000n),
      grant(new Date(NOW.getTime() - 5 * DAY), new Date(NOW.getTime() + 360 * DAY), 500n),
    ],
    NOW,
  );
  assert.equal(summary.activeStorageBytes, 500n);
  assert.equal(summary.nextExpiresAt?.getTime(), NOW.getTime() + 360 * DAY);
  // The lifecycle clock is the *last* expiry, not the first one to lapse.
  assert.equal(summary.lastExpiresAt?.getTime(), NOW.getTime() + 360 * DAY);
});

test("future grants do not count yet", () => {
  const summary = summarizeGrants(
    [grant(new Date(NOW.getTime() + DAY), new Date(NOW.getTime() + 30 * DAY), 5_000n)],
    NOW,
  );
  assert.equal(summary.activeStorageBytes, 0n);
  assert.equal(summary.activeCount, 0);
  assert.equal(summary.nextExpiresAt, null);
  assert.equal(summary.lastExpiresAt?.getTime(), NOW.getTime() + 30 * DAY);
});

test("no grants means no allowance and no lifecycle anchor", () => {
  const summary = summarizeGrants([], NOW);
  assert.equal(summary.activeStorageBytes, 0n);
  assert.equal(summary.lastExpiresAt, null);
  assert.equal(summary.nextExpiresAt, null);
});

test("add-grant parsing accepts a duration and an explicit window", () => {
  const parsed = parseAddGrantRequest(
    { storageBytes: "524288000", durationDays: 365, source: "workspace", sourceRef: "workspace:7:seat:3" },
    NOW,
  );
  assert.equal(parsed.storageBytes, 524_288_000n);
  assert.equal(parsed.source, "workspace");
  assert.equal(parsed.sourceRef, "workspace:7:seat:3");
  assert.equal(parsed.expiresAt.getTime(), NOW.getTime() + 365 * DAY);

  const windowed = parseAddGrantRequest(
    {
      storageBytes: "1000",
      startsAt: new Date(NOW.getTime() - DAY).toISOString(),
      expiresAt: new Date(NOW.getTime() + DAY).toISOString(),
      source: "legacy",
    },
    NOW,
  );
  assert.equal(windowed.startsAt.getTime(), NOW.getTime() - DAY);
  assert.equal(windowed.expiresAt.getTime(), NOW.getTime() + DAY);
});

test("add-grant parsing rejects bad input", () => {
  assert.throws(() => parseAddGrantRequest({ storageBytes: "0", durationDays: 1, source: "admin" }), GrantError);
  assert.throws(() => parseAddGrantRequest({ storageBytes: "1", durationDays: 0, source: "admin" }), GrantError);
  assert.throws(() => parseAddGrantRequest({ storageBytes: "1", durationDays: 1, source: "hacker" }), GrantError);
  assert.throws(
    () => parseAddGrantRequest({ storageBytes: "1", durationDays: 1, source: "admin", expiresAt: "not-a-date" }),
    GrantError,
  );
});

test("legacy entitlement translates to an additive grant", () => {
  const payment = parseLegacyEntitlement(
    { durationDays: 30, storageBytes: "5000000000", source: "payment", paymentHash: "a".repeat(64) },
    NOW,
  );
  assert.equal(payment.source, "payment");
  assert.equal(payment.sourceRef, "a".repeat(64));
  assert.equal(payment.storageBytes, 5_000_000_000n);
  assert.equal(payment.expiresAt.getTime(), NOW.getTime() + 30 * DAY);

  const admin = parseLegacyEntitlement(
    { durationDays: 30, storageBytes: "1", source: "admin" },
    NOW,
  );
  assert.match(admin.sourceRef ?? "", /^admin:/);

  const override = parseLegacyEntitlement(
    {
      durationDays: 30,
      storageBytes: "1",
      source: "admin",
      planExpiresAt: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    },
    NOW,
  );
  assert.equal(override.expiresAt.getTime(), NOW.getTime() + 5 * DAY);
});

test("workspace seat grants expose the pool owner encoded in sourceRef", () => {
  assert.equal(
    workspaceSeatOwner("workspace:owner:npub1owner:order:7:seat:2"),
    "npub1owner",
  );
  // The backend writes the owner's hex pubkey, not an npub.
  const hexOwner = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
  assert.equal(
    workspaceSeatOwner(`workspace:owner:${hexOwner}:order:7:seat:2`),
    nip19.npubEncode(hexOwner),
  );
  assert.equal(workspaceSeatOwner("workspace:42:seat:1"), null);
  assert.equal(workspaceSeatOwner("workspace:owner:not-a-pubkey:order:1:seat:1"), null);
  assert.equal(workspaceSeatOwner(null), null);
});

test("transfer parsing requires a selector and a distinct target", () => {
  const parsed = parseTransferRequest({
    fromNpub: "npub1owner",
    toNpub: "npub1member",
    source: "workspace",
    sourceRefPrefix: "workspace:7:",
    count: 2,
  });
  assert.equal(parsed.count, 2);
  assert.equal(parsed.sourceRefPrefix, "workspace:7:");

  assert.throws(
    () => parseTransferRequest({ fromNpub: "npub1a", toNpub: "npub1b" }),
    GrantError,
  );
  assert.throws(
    () => parseTransferRequest({ fromNpub: "npub1a", toNpub: "npub1a", source: "workspace" }),
    GrantError,
  );
});
