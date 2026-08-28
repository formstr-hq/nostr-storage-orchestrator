import { createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import WebSocket from "ws";

const BLOSSOM_URL = process.env.BLOSSOM_URL ?? "http://localhost:3001";
const RELAY_URL = process.env.RELAY_URL ?? "ws://localhost:8007";
// Must match what the relay server computes for its NIP-42 challenge
// (process.env.PUBLIC_URL on the server, defaulting to ws://localhost:$PORT).
const RELAY_PUBLIC_URL = process.env.RELAY_PUBLIC_URL ?? RELAY_URL;

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

// ---------------------------------------------------------------------------
// Relay (proxy/relay) — WebSocket Nostr relay protocol
// ---------------------------------------------------------------------------

type RelayMessage = unknown[];

class RelayTestClient {
  private ws: WebSocket;
  private queue: RelayMessage[] = [];
  private waiters: Array<{ predicate: (m: RelayMessage) => boolean; resolve: (m: RelayMessage) => void; timer: NodeJS.Timeout }> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as RelayMessage;
      const idx = this.waiters.findIndex((w) => w.predicate(msg));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        clearTimeout(w!.timer);
        w!.resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  async connected(timeoutMs = 5000): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket to open")), timeoutMs);
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  send(payload: RelayMessage): void {
    this.ws.send(JSON.stringify(payload));
  }

  async waitFor(predicate: (m: RelayMessage) => boolean, timeoutMs = 8000): Promise<RelayMessage> {
    const qi = this.queue.findIndex(predicate);
    if (qi >= 0) {
      const [m] = this.queue.splice(qi, 1);
      return m!;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("timed out waiting for relay message"));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve: resolve as (m: RelayMessage) => void, timer });
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function runRelaySuite(): Promise<void> {
  log("\nRelay (proxy/relay) — " + RELAY_URL);

  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);

  await step("rejects unauthenticated EVENT writes", async () => {
    const client = new RelayTestClient(RELAY_URL);
    try {
      await client.connected();
      await client.waitFor((m) => m[0] === "AUTH");
      const note = sign(sk, { kind: 1, created_at: nowSeconds(), tags: [], content: "should be rejected" });
      client.send(["EVENT", note]);
      const [, , ok, reason] = await client.waitFor((m) => m[0] === "OK" && m[1] === note.id);
      assert(ok === false, "expected unauthenticated write to be rejected");
      assert(typeof reason === "string" && reason.length > 0, "expected a rejection reason");
    } finally {
      client.close();
    }
  });

  const client = new RelayTestClient(RELAY_URL);
  let publishedEventId: string | undefined;

  try {
    await step("completes the NIP-42 AUTH handshake", async () => {
      await client.connected();
      const [, challenge] = await client.waitFor((m) => m[0] === "AUTH");
      assert(typeof challenge === "string", "expected a challenge string");
      const authEvent = sign(sk, {
        kind: 22242,
        created_at: nowSeconds(),
        tags: [
          ["relay", RELAY_PUBLIC_URL],
          ["challenge", challenge as string],
        ],
        content: "",
      });
      client.send(["AUTH", authEvent]);
      const [, , ok] = await client.waitFor((m) => m[0] === "OK" && m[1] === authEvent.id);
      assert(ok === true, "expected AUTH to be accepted");
    });

    await step("publishes a signed EVENT to backend relays", async () => {
      const note = sign(sk, { kind: 1, created_at: nowSeconds(), tags: [], content: `smoke-test-${Date.now()}` });
      client.send(["EVENT", note]);
      const [, , ok, reason] = await client.waitFor((m) => m[0] === "OK" && m[1] === note.id);
      assert(
        ok === true,
        `expected publish to succeed, got rejection: ${reason}. ` +
          "Is the storage-client backend relay (strfry) running and reachable?",
      );
      publishedEventId = note.id;
    });

    await step("live subscription receives events after EOSE", async () => {
      const subId = `smoke-live-${Date.now()}`;
      client.send(["REQ", subId, { kinds: [1], authors: [pubkey] }]);
      await client.waitFor((m) => m[0] === "EOSE" && m[1] === subId);

      const liveNote = sign(sk, {
        kind: 1,
        created_at: nowSeconds(),
        tags: [],
        content: `smoke-live-${Date.now()}`,
      });
      client.send(["EVENT", liveNote]);
      const [, , ok, reason] = await client.waitFor((m) => m[0] === "OK" && m[1] === liveNote.id);
      assert(
        ok === true,
        `expected live publish to succeed, got rejection: ${reason}. ` +
          "Is the storage-client backend relay (strfry) running and reachable?",
      );

      const [, , event] = await client.waitFor((m) => m[0] === "EVENT" && m[1] === subId);
      assert((event as { id: string }).id === liveNote.id, "live subscription did not receive published event");

      client.send(["CLOSE", subId]);
    });

    await step("NIP-11 relay information document is available", async () => {
      const httpUrl = RELAY_URL.replace(/^ws/, "http");
      const response = await fetch(httpUrl, {
        headers: { Accept: "application/nostr+json" },
      });
      assert(response.ok, `expected HTTP success, got ${response.status}`);
      assert(
        (response.headers.get("content-type") ?? "").includes("application/nostr+json"),
        "expected application/nostr+json content type",
      );
      const body = (await response.json()) as {
        supported_nips: number[];
        limitation: { restricted_writes: boolean };
      };
      assert(body.supported_nips.includes(1), "expected NIP-01 in supported_nips");
      assert(body.supported_nips.includes(11), "expected NIP-11 in supported_nips");
      assert(body.supported_nips.includes(42), "expected NIP-42 in supported_nips");
      assert(body.limitation.restricted_writes === true, "expected restricted_writes=true");
    });

    await step("kind-5 deletion removes the event for its owner", async () => {
      assert(publishedEventId, "no published event id from previous step");
      const deletion = sign(sk, {
        kind: 5,
        created_at: nowSeconds(),
        tags: [["e", publishedEventId]],
        content: "",
      });
      client.send(["EVENT", deletion]);
      const [, , ok] = await client.waitFor((m) => m[0] === "OK" && m[1] === deletion.id);
      assert(ok === true, "expected deletion to be accepted");
    });
  } finally {
    client.close();
  }
}

async function main(): Promise<void> {
  log(`Running docker smoke tests against:`);
  log(`  BLOSSOM_URL = ${BLOSSOM_URL}`);
  log(`  RELAY_URL   = ${RELAY_URL}`);

  await runBlossomSuite();
  await runRelaySuite();

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
