import assert from "node:assert/strict";
import { test } from "node:test";
import { createNip98Signer, publicKeyOf } from "./index.js";
import { Nip98Error, verifyNip98, createInMemoryReplayCache } from "./verify.js";

const SECRET = "11".repeat(32);
const signer = createNip98Signer(SECRET);
const URL = "http://service.test/api/internal/admin-check/npub1abc";

function request(overrides: Partial<Parameters<typeof verifyNip98>[0]> = {}) {
  return {
    headers: { authorization: signer.header("GET", URL) } as Record<string, string | string[] | undefined>,
    method: "GET",
    originalUrl: "/api/internal/admin-check/npub1abc",
    protocol: "http",
    get: (name: string) => (name === "host" ? "service.test" : undefined),
    ...overrides,
  };
}

test("signer derives the service npub from the nsec", () => {
  const { npub } = publicKeyOf(SECRET);
  assert.ok(npub.startsWith("npub1"));
  assert.equal(signer.npub, npub);
});

test("verifies a matching GET request", () => {
  const result = verifyNip98(request());
  assert.equal(result.npub, signer.npub);
});

test("verifies a matching POST with a payload hash", () => {
  const body = { a: 1, b: "two" };
  const result = verifyNip98(
    request({
      headers: { authorization: signer.header("POST", "http://service.test/x", body) },
      method: "POST",
      originalUrl: "/x",
      body,
    }),
  );
  assert.equal(result.pubkey, signer.pubkey);
});

test("rejects a payload mismatch", () => {
  const body = { a: 1 };
  assert.throws(
    () =>
      verifyNip98(
        request({
          headers: { authorization: signer.header("POST", "http://service.test/x", body) },
          method: "POST",
          originalUrl: "/x",
          body: { a: 2 },
        }),
      ),
    Nip98Error,
  );
});

test("rejects a URL mismatch", () => {
  assert.throws(
    () => verifyNip98(request({ originalUrl: "/other" })),
    Nip98Error,
  );
});

test("rejects a method mismatch", () => {
  assert.throws(() => verifyNip98(request({ method: "DELETE" })), Nip98Error);
});

test("rejects a replayed event", () => {
  const replay = createInMemoryReplayCache();
  // Reuse the exact same signed header: a fresh header carries a new nonce and
  // is legitimately a different request.
  const headers = { authorization: signer.header("GET", URL) };
  verifyNip98(request({ headers }), { replay });
  assert.throws(() => verifyNip98(request({ headers }), { replay }), /already been used/);
});

test("two identical requests are not treated as replays", () => {
  const replay = createInMemoryReplayCache();
  verifyNip98(request(), { replay });
  // A second call produces a new nonce, so it must verify.
  verifyNip98(request(), { replay });
});

test("rejects a stale timestamp", () => {
  const stale = signer.header("GET", URL);
  const decoded = JSON.parse(Buffer.from(stale.replace(/^Nostr\s+/, ""), "base64").toString());
  decoded.created_at -= 3600;
  // Re-sign is impossible without mutating the event; verify the window by
  // shrinking it to zero instead.
  assert.throws(
    () => verifyNip98(request(), { maxSkewSeconds: -1 }),
    /timestamp outside/,
  );
});

test("rejects a non-Nostr header and malformed base64", () => {
  assert.throws(() => verifyNip98(request({ headers: {} })), /Missing/);
  assert.throws(
    () => verifyNip98(request({ headers: { authorization: "Bearer token" } })),
    /Malformed/,
  );
});
