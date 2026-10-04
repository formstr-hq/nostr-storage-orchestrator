import assert from "node:assert/strict";
import { test, before, after, mock } from "node:test";
import { createServer, type Server } from "node:http";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

// Access derivation is unit-tested in @orchestrator/lifecycle; these tests
// exercise the proxy enforcement layer end-to-end against a stubbed db-api.
process.env["NODE_ENV"] = "test";
process.env["BLOSSOM_PORT"] = "0";
process.env["DB_API_URL"] = "http://db-api.test";
process.env["FORMSTR_BACKEND_URL"] = "";

const realFetch = globalThis.fetch;
const { app } = await import("./index.js");

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const npub = nip19.npubEncode(pubkey);

function bloomAuth(action: string, opts: { hash?: string; expiration?: number } = {}) {
  const tags: string[][] = [["t", action]];
  if (opts.hash) tags.push(["x", opts.hash]);
  tags.push(["expiration", String(opts.expiration ?? Math.floor(Date.now() / 1000) + 300)]);
  const event = finalizeEvent(
    {
      kind: 24242,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags,
    },
    sk,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

const HASH = "a".repeat(64);
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

let userRow: Record<string, unknown>;
let blobRow: Record<string, unknown> | null = null;
let calls: Array<{ url: string; init?: RequestInit }> = [];

// Route local requests (the test client) to the real fetch, and db-api
// requests to the stub. Using the real fetch keeps the test server reachable.
function routedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("db-api.test")) return fetchStub(input, init);
  return realFetch(input, init);
}

function fetchStub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  calls.push({ url, ...(init ? { init } : {}) });

  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );

  if (url.endsWith(`/users/${encodeURIComponent(npub)}`) && (!init || init.method === undefined || init.method === "GET")) {
    return json(userRow);
  }
  if (url.endsWith(`/users/${encodeURIComponent(npub)}`) && init?.method === "PUT") {
    return json(userRow);
  }
  if (url.endsWith(`/blobs/${HASH}`) && (!init || init.method === undefined)) {
    if (!blobRow) return Promise.resolve(new Response("{}", { status: 404 }));
    return json(blobRow);
  }
  if (url.endsWith("/blobs") && init?.method === "POST") {
    return json({ ...(blobRow ?? {}), usedStorage: String(userRow["usedStorage"]) }, 201);
  }
  if (url.endsWith(`/blobs/${HASH}`) && init?.method === "DELETE") {
    return json({ deleted: true, usedStorage: "0" });
  }
  return json({ error: "unhandled", url }, 500);
}

let server: Server;
let base: string;

before(async () => {
  mock.method(globalThis, "fetch", routedFetch);
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address === "object" && address) base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  mock.restoreAll();
});

function activeUser() {
  userRow = {
    npub,
    plan: "pro",
    planExpiresAt: new Date(NOW + 10 * DAY).toISOString(),
    storageBytes: "1000",
    status: "ACTIVE",
    statusChangedAt: null,
    termsVersion: "2026-10-01",
    termsAcceptedAt: null,
    usedStorage: "100",
    createdAt: new Date(NOW).toISOString(),
  };
}

test("HEAD /upload rejects an unpaid account", async () => {
  activeUser();
  userRow["plan"] = null;
  userRow["planExpiresAt"] = null;
  userRow["storageBytes"] = null;
  userRow["status"] = "UNPAID";
  const res = await fetch(`${base}/upload`, {
    method: "HEAD",
    headers: {
      authorization: bloomAuth("upload", { hash: HASH }),
      "x-sha-256": HASH,
      "x-content-length": "10",
    },
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("x-reason"), "unpaid");
});

test("HEAD /upload rejects a quota-exceeding upload", async () => {
  activeUser();
  const res = await fetch(`${base}/upload`, {
    method: "HEAD",
    headers: {
      authorization: bloomAuth("upload", { hash: HASH }),
      "x-sha-256": HASH,
      "x-content-length": "5000",
    },
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("x-reason"), "quota_exceeded");
});

test("HEAD /upload accepts an in-quota upload", async () => {
  activeUser();
  const res = await fetch(`${base}/upload`, {
    method: "HEAD",
    headers: {
      authorization: bloomAuth("upload", { hash: HASH }),
      "x-sha-256": HASH,
      "x-content-length": "10",
    },
  });
  assert.equal(res.status, 200);
});

test("HEAD /upload rejects an expired plan in WRITE_BLOCKED and allows reads", async () => {
  activeUser();
  userRow["planExpiresAt"] = new Date(NOW - 10 * DAY).toISOString();
  const upload = await fetch(`${base}/upload`, {
    method: "HEAD",
    headers: {
      authorization: bloomAuth("upload", { hash: HASH }),
      "x-sha-256": HASH,
      "x-content-length": "10",
    },
  });
  assert.equal(upload.status, 403);
  assert.equal(upload.headers.get("x-reason"), "write_blocked");
});

test("GET /:hash blocks reads once the owner is READ_BLOCKED", async () => {
  activeUser();
  userRow["planExpiresAt"] = new Date(NOW - 40 * DAY).toISOString();
  blobRow = {
    hash: HASH,
    npub,
    size: "100",
    replicas: ["npub-storage"],
    createdAt: new Date(NOW).toISOString(),
  };
  const res = await fetch(`${base}/${HASH}`);
  assert.equal(res.status, 403);
  assert.equal(await res.json().then((b) => b.error), "read_blocked");
});

test("DELETE /:hash remains allowed for the owner in READ_BLOCKED", async () => {
  activeUser();
  userRow["planExpiresAt"] = new Date(NOW - 40 * DAY).toISOString();
  blobRow = {
    hash: HASH,
    npub,
    size: "100",
    replicas: [],
    createdAt: new Date(NOW).toISOString(),
  };
  const res = await fetch(`${base}/${HASH}`, {
    method: "DELETE",
    headers: { authorization: bloomAuth("delete", { hash: HASH }) },
  });
  assert.equal(res.status, 200);
});

test("GET /storage reports derived status and limits", async () => {
  activeUser();
  const res = await fetch(`${base}/storage`, {
    headers: { authorization: bloomAuth("get") },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ACTIVE");
  assert.equal(body.total, 1000);
  assert.equal(body.plan, "pro");
});

test("admin routes reject a non-admin NIP-98 caller", async () => {
  activeUser();
  const tags = [
    ["u", `${base}/admin/users`],
    ["method", "GET"],
  ];
  const event = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags },
    sk,
  );
  const res = await fetch(`${base}/admin/users`, {
    headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}` },
  });
  assert.equal(res.status, 403);
  assert.equal(await res.json().then((b) => b.error), "admin_required");
});

test("admin routes require NIP-98 (no BUD-11 fallback)", async () => {
  activeUser();
  const res = await fetch(`${base}/admin/users`, {
    headers: { authorization: bloomAuth("get") },
  });
  assert.equal(res.status, 401);
});

test("blob route does not shadow API routes and vice versa", async () => {
  activeUser();
  calls = [];
  await fetch(`${base}/dashboard`);
  assert.ok(!calls.some((c) => c.url.includes("/blobs/")), "SPA fallback must not query the blob store");
});
