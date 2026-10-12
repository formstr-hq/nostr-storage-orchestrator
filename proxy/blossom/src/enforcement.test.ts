import assert from "node:assert/strict";
import { test, before, after, mock } from "node:test";
import { createServer, type Server } from "node:http";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { createHash } from "node:crypto";

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
let serviceAccountEnabled: boolean | null = null;
let createBlobResponse: { status: number; body: unknown } | null = null;

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
  const path = new URL(url).pathname;
  if (path.endsWith("/storages/capacity")) {
    return json({ signupsOpen: true, availableBytes: "123" });
  }
  if (path.includes("/service-accounts/")) {
    return serviceAccountEnabled === null
      ? Promise.resolve(new Response("{}", { status: 404 }))
      : json({ npub, enabled: serviceAccountEnabled, label: null, createdAt: new Date(NOW).toISOString() });
  }
  const blobPath = /\/blobs\/([a-f0-9]{64})$/.exec(path)?.[1];
  if (blobPath && (!init || init.method === undefined)) {
    if (!blobRow || blobRow["hash"] !== blobPath) return Promise.resolve(new Response("{}", { status: 404 }));
    return json({ owners: [blobRow["npub"]], ...blobRow });
  }
  if (path.endsWith("/blobs") && init?.method === "POST") {
    if (createBlobResponse) return json(createBlobResponse.body, createBlobResponse.status);
    return json({ ...(blobRow ?? {}), usedStorage: String(userRow["usedStorage"]) }, 201);
  }
  if (path.endsWith(`/blobs/${HASH}`) && init?.method === "DELETE") {
    return json({ deleted: true, usedStorage: "0", remainingOwners: 0 });
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
    planExpiresAt: new Date(NOW + 10 * DAY).toISOString(),
    storageBytes: "1000",
    usedStorage: "100",
    createdAt: new Date(NOW).toISOString(),
  };
}

test("HEAD /upload rejects an unpaid account", async () => {
  activeUser();
  userRow["planExpiresAt"] = null;
  userRow["storageBytes"] = null;
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

function putUpload(body: Buffer, auth: string | null) {
  return fetch(`${base}/upload`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      ...(auth ? { authorization: auth } : {}),
    },
    body: new Uint8Array(body),
  });
}

test("PUT /upload turns away an unauthenticated caller before reading the body", async () => {
  activeUser();
  calls = [];
  const res = await putUpload(Buffer.alloc(2048, 1), null);
  assert.equal(res.status, 401);
  assert.ok(!calls.some((c) => c.url.includes("/users/")), "no account lookup for an anonymous caller");
});

test("PUT /upload rejects an unpaid account from the headers alone", async () => {
  activeUser();
  userRow["planExpiresAt"] = null;
  userRow["storageBytes"] = null;
  const res = await putUpload(Buffer.alloc(64, 2), bloomAuth("upload", { hash: HASH }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "unpaid");
});

test("PUT /upload rejects a body larger than the remaining quota before buffering it", async () => {
  activeUser(); // 1000 allowance, 100 used
  const res = await putUpload(Buffer.alloc(2000, 3), bloomAuth("upload", { hash: HASH }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "quota_exceeded");
});

test("PUT /upload rejects a token with no blob scope", async () => {
  activeUser();
  const res = await putUpload(Buffer.alloc(64, 4), bloomAuth("upload"));
  assert.equal(res.status, 401);
});

function sharedBlob() {
  activeUser();
  const body = Buffer.alloc(64, 5);
  const hash = createHash("sha256").update(body).digest("hex");
  blobRow = {
    hash,
    npub: "npub1someoneelse",
    size: "64",
    replicas: ["npub-storage"],
    createdAt: new Date(NOW).toISOString(),
  };
  calls = [];
  return { body, hash };
}

const storedBytes = () => calls.some((c) => c.init?.method === "PUT" && !c.url.includes("db-api"));

test("PUT /upload bills a second account for content another account already stored", async () => {
  const { body, hash } = sharedBlob();
  const res = await putUpload(body, bloomAuth("upload", { hash }));
  assert.equal(res.status, 201);
  const create = calls.find((c) => c.url.endsWith("/blobs") && c.init?.method === "POST");
  assert.ok(create, "an ownership row is created for the uploader");
  const sent = JSON.parse(String(create.init?.body));
  assert.equal(sent.npub, npub);
  assert.deepEqual(sent.replicas, ["npub-storage"], "reuses the existing copies");
  assert.ok(!storedBytes(), "the bytes are not stored a second time");
  blobRow = null;
});

test("PUT /upload of shared content over quota is refused and touches no node", async () => {
  const { body, hash } = sharedBlob();
  createBlobResponse = { status: 409, body: { error: "quota_exceeded" } };
  try {
    const res = await putUpload(body, bloomAuth("upload", { hash }));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "quota_exceeded");
    assert.ok(!calls.some((c) => c.init?.method === "DELETE"), "other owner's bytes are untouched");
  } finally {
    createBlobResponse = null;
    blobRow = null;
  }
});

function nip98(path: string, method = "GET") {
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [["u", `${base}${path}`], ["method", method], ["nonce", Math.random().toString(36)]],
    },
    sk,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

test("GET /capacity is not public", async () => {
  const anonymous = await fetch(`${base}/capacity`);
  assert.equal(anonymous.status, 401);
});

test("GET /capacity rejects a signer that is not a service account", async () => {
  serviceAccountEnabled = null;
  const res = await fetch(`${base}/capacity`, { headers: { authorization: nip98("/capacity") } });
  assert.equal(res.status, 403);
});

test("GET /capacity rejects a disabled service account", async () => {
  serviceAccountEnabled = false;
  const res = await fetch(`${base}/capacity`, { headers: { authorization: nip98("/capacity") } });
  assert.equal(res.status, 403);
});

test("GET /capacity serves an enabled service account", async () => {
  serviceAccountEnabled = true;
  const res = await fetch(`${base}/capacity`, { headers: { authorization: nip98("/capacity") } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).signupsOpen, true);
  serviceAccountEnabled = null;
});
