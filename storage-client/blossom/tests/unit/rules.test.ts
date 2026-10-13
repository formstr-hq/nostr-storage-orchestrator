/**
 * Unit tests for the storage-rule upload gate (getFileRule).
 *
 * The rule list doubles as the upload allowlist: a MIME type that matches no
 * rule is rejected with 415. An empty list is the documented "accept any MIME
 * type, no expiry" mode — except when requirePubkeyInRule is set, which keeps
 * the node invite-only even without rules.
 */

import { assertEquals, assertStrictEquals } from "@std/assert";
import { ALLOW_ALL, getFileRule } from "../../src/prune/rules.ts";
import type { StorageRule } from "../../src/config/schema.ts";

const IMAGE: StorageRule = { type: "image/*", expiration: "1 month" };
const ALL: StorageRule = { type: "*", expiration: "1 week" };
const SCOPED: StorageRule = {
  type: "*",
  expiration: "1 week",
  pubkeys: ["a".repeat(64)],
};

// ---------------------------------------------------------------------------
// Empty rule list — accept-anything / no-expiry mode
// ---------------------------------------------------------------------------

Deno.test("empty rules accept any MIME type", () => {
  assertStrictEquals(
    getFileRule({ mimeType: "application/octet-stream" }, []),
    ALLOW_ALL,
  );
  assertStrictEquals(getFileRule({ mimeType: "image/png" }, []), ALLOW_ALL);
  assertStrictEquals(
    getFileRule({ mimeType: "application/pdf" }, []),
    ALLOW_ALL,
  );
});

Deno.test("empty rules accept an unknown MIME type", () => {
  assertStrictEquals(getFileRule({ mimeType: null }, []), ALLOW_ALL);
});

Deno.test("empty rules still deny when requirePubkeyInRule is set", () => {
  assertEquals(
    getFileRule({ mimeType: "image/png", pubkey: "a".repeat(64) }, [], true),
    null,
  );
  assertEquals(getFileRule({ mimeType: "image/png" }, [], true), null);
});

// ---------------------------------------------------------------------------
// Non-empty list — first match wins, no match denies
// ---------------------------------------------------------------------------

Deno.test("first matching rule wins", () => {
  assertStrictEquals(
    getFileRule({ mimeType: "image/png" }, [IMAGE, ALL]),
    IMAGE,
  );
  assertStrictEquals(
    getFileRule({ mimeType: "application/pdf" }, [IMAGE, ALL]),
    ALL,
  );
});

Deno.test("a MIME type matching no rule is rejected", () => {
  assertEquals(getFileRule({ mimeType: "application/pdf" }, [IMAGE]), null);
});

Deno.test("wildcard rule matches an unknown MIME type", () => {
  assertStrictEquals(getFileRule({ mimeType: null }, [IMAGE, ALL]), ALL);
});

// ---------------------------------------------------------------------------
// Pubkey scoping
// ---------------------------------------------------------------------------

Deno.test("pubkey-scoped rules only match their pubkeys", () => {
  assertStrictEquals(
    getFileRule({ mimeType: "image/png", pubkey: "a".repeat(64) }, [SCOPED]),
    SCOPED,
  );
  assertEquals(
    getFileRule({ mimeType: "image/png", pubkey: "b".repeat(64) }, [SCOPED]),
    null,
  );
  assertEquals(getFileRule({ mimeType: "image/png" }, [SCOPED]), null);
});

Deno.test("requirePubkeyInRule skips unscoped rules", () => {
  assertEquals(
    getFileRule(
      { mimeType: "image/png", pubkey: "a".repeat(64) },
      [IMAGE],
      true,
    ),
    null,
  );
  assertStrictEquals(
    getFileRule({ mimeType: "image/png", pubkey: "a".repeat(64) }, [
      IMAGE,
      SCOPED,
    ], true),
    SCOPED,
  );
});
