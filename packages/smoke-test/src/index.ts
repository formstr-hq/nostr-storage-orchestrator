import { createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, type EventTemplate } from "nostr-tools/pure";

const BLOSSOM_URL = process.env.BLOSSOM_URL ?? "http://localhost:3001";

let failures = 0;

function log(message: string): void {
  console.log(message);
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  - ${name} ... `);
  try {
    await fn();
    console.log("OK");
  } catch (error) {
    failures++;
    console.log("FAIL");
    console.error(`    ${error instanceof Error ? error.stack ?? error.message : error}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sign(sk: Uint8Array, template: EventTemplate) {
  return finalizeEvent(template, sk);
}

// Builds a BUD-11 Nostr authorization token. `hash`, when given, is added as
// an `x` tag scoping the token to that blob; omit it to test the unscoped
// case. `kind`/`expired` let individual tests build a deliberately
// non-conformant token to verify the proxy rejects it.
function blossomAuthToken(
  sk: Uint8Array,
  action: "get" | "upload" | "delete" | "list" | "media",
  opts: { hash?: string; kind?: number; expired?: boolean } = {},
): string {
  const tags: string[][] = [["t", action]];
  if (opts.hash) tags.push(["x", opts.hash]);
  const expiration = opts.expired ? nowSeconds() - 60 : nowSeconds() + 3600;
  tags.push(["expiration", String(expiration)]);

  const event = sign(sk, {
    kind: opts.kind ?? 24242,
    created_at: nowSeconds(),
    tags,
    content: `smoke-test ${action}`,
  });
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Blossom (proxy/blossom) — REST API over HTTP, per BUD-01/02/11/12
// ---------------------------------------------------------------------------

async function runBlossomSuite(): Promise<void> {
  log("\nBlossom (proxy/blossom) — " + BLOSSOM_URL);

  const sk = generateSecretKey();
  const payload = Buffer.from(`smoke-test-${Date.now()}-${Math.random()}`);
  const payloadHash = createHash("sha256").update(payload).digest("hex");

  await step("rejects requests without an Authorization header", async () => {
    const res = await fetch(`${BLOSSOM_URL}/storage`);
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await step("rejects a non-24242 kind auth token", async () => {
    const auth = blossomAuthToken(sk, "get", { kind: 27235 });
    const res = await fetch(`${BLOSSOM_URL}/storage`, { headers: { authorization: auth } });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await step("rejects an expired auth token", async () => {
    const auth = blossomAuthToken(sk, "get", { expired: true });
    const res = await fetch(`${BLOSSOM_URL}/storage`, { headers: { authorization: auth } });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await step('rejects a token whose "t" tag does not match the endpoint\'s action', async () => {
    const auth = blossomAuthToken(sk, "delete");
    const res = await fetch(`${BLOSSOM_URL}/storage`, { headers: { authorization: auth } });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await step("GET /storage returns a fresh FREE-plan user", async () => {
    const auth = blossomAuthToken(sk, "get");
    const res = await fetch(`${BLOSSOM_URL}/storage`, { headers: { authorization: auth } });
    assert(res.ok, `expected 2xx, got ${res.status}`);
    const body = (await res.json()) as { plan: string; used: number };
    assert(body.plan === "FREE", `expected plan FREE, got ${body.plan}`);
    assert(body.used === 0, `expected used=0 for a fresh user, got ${body.used}`);
  });

  await step('rejects PUT /upload when the auth token has no "x" tag', async () => {
    const auth = blossomAuthToken(sk, "upload");
    const res = await fetch(`${BLOSSOM_URL}/upload`, {
      method: "PUT",
      headers: { authorization: auth, "content-type": "application/octet-stream" },
      body: payload,
    });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await step("HEAD /upload accepts a correctly-scoped pre-flight check", async () => {
    const auth = blossomAuthToken(sk, "upload", { hash: payloadHash });
    const res = await fetch(`${BLOSSOM_URL}/upload`, {
      method: "HEAD",
      headers: {
        authorization: auth,
        "x-sha-256": payloadHash,
        "x-content-length": String(payload.length),
        "x-content-type": "application/octet-stream",
      },
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
  });

  await step("PUT /upload stores a blob and returns a 201 Blob Descriptor", async () => {
    const auth = blossomAuthToken(sk, "upload", { hash: payloadHash });
    const res = await fetch(`${BLOSSOM_URL}/upload`, {
      method: "PUT",
      headers: { authorization: auth, "content-type": "application/octet-stream" },
      body: payload,
    });
    const rawBody = await res.text();
    assert(res.status === 201, `expected 201, got ${res.status}: ${rawBody}`);
    const body = JSON.parse(rawBody) as { url: string; sha256: string; size: number; type: string; uploaded: number };
    assert(body.sha256 === payloadHash, `expected sha256 ${payloadHash}, got ${body.sha256}`);
    assert(body.size === payload.length, `expected size ${payload.length}, got ${body.size}`);
    assert(typeof body.uploaded === "number", "expected a numeric uploaded timestamp");
    assert(/\.[a-zA-Z0-9]+$/.test(body.url), `expected descriptor url to include a file extension, got ${body.url}`);
  });

  await step("PUT /upload of the same blob returns 200 OK (dedup)", async () => {
    const auth = blossomAuthToken(sk, "upload", { hash: payloadHash });
    const res = await fetch(`${BLOSSOM_URL}/upload`, {
      method: "PUT",
      headers: { authorization: auth, "content-type": "application/octet-stream" },
      body: payload,
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
  });

  await step("GET /storage reflects the uploaded blob's size", async () => {
    const auth = blossomAuthToken(sk, "get");
    const res = await fetch(`${BLOSSOM_URL}/storage`, { headers: { authorization: auth } });
    const body = (await res.json()) as { used: number };
    assert(body.used === payload.length, `expected used=${payload.length}, got ${body.used}`);
  });

  // Blob reads are deliberately public — see handleGetBlob in
  // proxy/blossom/src/index.ts, where the auth and ownership checks are
  // commented out. These two steps pin that decision down so re-tightening
  // GET is a conscious change that fails here first, rather than a silent
  // break for every unauthenticated reader.
  await step("GET /<sha256> is public — no Authorization header needed", async () => {
    const res = await fetch(`${BLOSSOM_URL}/${payloadHash}`);
    assert(res.ok, `expected 2xx, got ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert(bytes.equals(payload), "downloaded bytes do not match uploaded bytes");
  });

  await step('GET /<sha256> ignores a token whose "x" tag names a different hash', async () => {
    const auth = blossomAuthToken(sk, "get", { hash: "0".repeat(64) });
    const res = await fetch(`${BLOSSOM_URL}/${payloadHash}`, { headers: { authorization: auth } });
    assert(res.ok, `expected 2xx, got ${res.status}`);
  });

  await step("GET /<sha256> 404s for a blob that was never uploaded", async () => {
    const res = await fetch(`${BLOSSOM_URL}/${"1".repeat(64)}`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  await step("HEAD /<sha256> returns metadata headers without a body", async () => {
    const auth = blossomAuthToken(sk, "get", { hash: payloadHash });
    const res = await fetch(`${BLOSSOM_URL}/${payloadHash}`, { method: "HEAD", headers: { authorization: auth } });
    assert(res.ok, `expected 2xx, got ${res.status}`);
    assert(
      res.headers.get("content-length") === String(payload.length),
      `expected content-length ${payload.length}, got ${res.headers.get("content-length")}`,
    );
    const bytes = await res.arrayBuffer();
    assert(bytes.byteLength === 0, "expected HEAD to return an empty body");
  });

  await step("GET /<sha256> returns the original bytes", async () => {
    const auth = blossomAuthToken(sk, "get", { hash: payloadHash });
    const res = await fetch(`${BLOSSOM_URL}/${payloadHash}`, { headers: { authorization: auth } });
    assert(res.ok, `expected 2xx, got ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert(bytes.equals(payload), "downloaded bytes do not match uploaded bytes");
  });

  await step("GET /<sha256>.ext accepts an arbitrary file extension", async () => {
    const auth = blossomAuthToken(sk, "get", { hash: payloadHash });
    const res = await fetch(`${BLOSSOM_URL}/${payloadHash}.bin`, { headers: { authorization: auth } });
    assert(res.ok, `expected 2xx, got ${res.status}`);
  });

  await step('rejects DELETE /<sha256> when the auth token has no "x" tag', async () => {
    const auth = blossomAuthToken(sk, "delete");
    const res = await fetch(`${BLOSSOM_URL}/${payloadHash}`, { method: "DELETE", headers: { authorization: auth } });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await step("DELETE /<sha256> removes the blob and decrements usage", async () => {
    const auth = blossomAuthToken(sk, "delete", { hash: payloadHash });
    const del = await fetch(`${BLOSSOM_URL}/${payloadHash}`, { method: "DELETE", headers: { authorization: auth } });
    assert(del.ok, `expected 2xx, got ${del.status}`);

    const storageAuth = blossomAuthToken(sk, "get");
    const storage = await fetch(`${BLOSSOM_URL}/storage`, { headers: { authorization: storageAuth } });
    const body = (await storage.json()) as { used: number };
    assert(body.used === 0, `expected used=0 after delete, got ${body.used}`);
  });

  await step("GET /<sha256> 404s after delete", async () => {
    const auth = blossomAuthToken(sk, "get", { hash: payloadHash });
    const res = await fetch(`${BLOSSOM_URL}/${payloadHash}`, { headers: { authorization: auth } });
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });
}


async function main(): Promise<void> {
  log(`Running docker smoke tests against:`);
  log(`  BLOSSOM_URL = ${BLOSSOM_URL}`);

  await runBlossomSuite();

  console.log("");
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("All checks passed.");
}

main().catch((error) => {
  console.error("Smoke test crashed:", error);
  process.exit(1);
});
