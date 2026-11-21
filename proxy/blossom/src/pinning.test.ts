import assert from "node:assert/strict";
import { test, before, after, mock } from "node:test";
import { createServer, type Server } from "node:http";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { createHash } from "node:crypto";
import axios from "axios";

// BUD "Blob pinning" (hzrd149/blossom#117): a `p` tag on an upload token pins
// the blob for that pubkey instead of the signer, and the pinned account is
// the one billed. These tests exercise the full proxy against a stubbed
// db-api and a stubbed storage provider.
process.env["NODE_ENV"] = "test";
process.env["BLOSSOM_PORT"] = "0";
process.env["DB_API_URL"] = "http://db-api.test";
process.env["FORMSTR_BACKEND_URL"] = "";
process.env["BLOSSOM_REPLICAS"] = "1";

const realFetch = globalThis.fetch;
const { app } = await import("./index.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function keypair() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return { sk, pk, npub: nip19.npubEncode(pk) };
}

const sender = keypair();
const recipient = keypair();
const other = keypair();
const stranger = keypair();

/** Signed BUD-11 token; `pins` become hex `p` tags. */
function auth(
  signer: { sk: Uint8Array },
  action: string,
  opts: { hash?: string; pins?: string[] } = {},
) {
  const tags: string[][] = [["t", action]];
  if (opts.hash) tags.push(["x", opts.hash]);
  for (const pin of opts.pins ?? []) tags.push(["p", pin]);
  tags.push(["expiration", String(Math.floor(Date.now() / 1000) + 300)]);
  const event = finalizeEvent(
    {
      kind: 24242,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags,
    },
    signer.sk,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

interface UserRow {
  npub: string;
  planExpiresAt: string | null;
  storageBytes: string | null;
  usedStorage: string;
  createdAt: string;
}

interface BlobRow {
  hash: string;
  npub: string;
  size: string;
  replicas: string[];
  createdAt: string;
}

const users = new Map<string, UserRow>();
const blobs: BlobRow[] = [];

function paying(npub: string, storageBytes = "2000", usedStorage = "0") {
  users.set(npub, {
    npub,
    planExpiresAt: new Date(NOW + 10 * DAY).toISOString(),
    storageBytes,
    usedStorage,
    createdAt: new Date(NOW).toISOString(),
  });
}

function reset() {
  users.clear();
  blobs.length = 0;
}

function hashOf(body: Buffer) {
  return createHash("sha256").update(body).digest("hex");
}

function seedBlob(hash: string, npub: string, size: number) {
  blobs.push({
    hash,
    npub,
    size: String(size),
    replicas: ["npub-provider"],
    createdAt: new Date(NOW).toISOString(),
  });
}

function userFor(npub: string) {
  return users.get(npub) ?? null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchStub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  const parsed = new URL(url);
  const path = parsed.pathname;
  const method = init?.method ?? "GET";

  const userMatch = /^\/users\/([^/]+)$/.exec(path);
  if (userMatch && method === "GET") {
    const user = userFor(decodeURIComponent(userMatch[1]!));
    return Promise.resolve(user ? json(user) : new Response("{}", { status: 404 }));
  }

  if (path === "/storages/active") {
    return Promise.resolve(
      json([{ npub: "npub-provider", tunnelIp: "10.44.0.8", blossomPort: 3000 }]),
    );
  }

  const blobMatch = /^\/blobs\/([a-f0-9]{64})$/.exec(path);
  if (blobMatch && method === "GET") {
    const rows = blobs.filter((row) => row.hash === blobMatch[1]);
    if (rows.length === 0) return Promise.resolve(new Response("{}", { status: 404 }));
    const first = rows[0]!;
    return Promise.resolve(
      json({
        ...first,
        owners: rows.map((row) => row.npub),
        pins: rows.map((row) => ({ npub: row.npub, createdAt: row.createdAt })),
      }),
    );
  }

  if (path === "/blobs" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as Omit<BlobRow, "createdAt">;
    const user = userFor(body.npub);
    if (!user) return Promise.resolve(json({ error: "user_not_found" }, 404));
    if (hasPin(body.hash, body.npub)) {
      return Promise.resolve(json({ error: "already_exists" }, 409));
    }
    if (
      user.storageBytes !== null &&
      BigInt(user.usedStorage) + BigInt(body.size) > BigInt(user.storageBytes)
    ) {
      return Promise.resolve(json({ error: "quota_exceeded" }, 409));
    }
    const row: BlobRow = {
      hash: body.hash,
      npub: body.npub,
      size: String(body.size),
      replicas: body.replicas,
      createdAt: new Date().toISOString(),
    };
    blobs.push(row);
    user.usedStorage = (BigInt(user.usedStorage) + BigInt(body.size)).toString();
    return Promise.resolve(json({ ...row, usedStorage: user.usedStorage }, 201));
  }

  if (blobMatch && method === "DELETE") {
    const hash = blobMatch[1]!;
    const npub = parsed.searchParams.get("npub");
    const all = parsed.searchParams.get("all") === "true";
    const keep: BlobRow[] = [];
    let removed = 0;
    for (const row of blobs.filter((entry) => entry.hash === hash)) {
      if (all || row.npub === npub) {
        const user = userFor(row.npub);
        if (user) {
          user.usedStorage = (BigInt(user.usedStorage) - BigInt(row.size)).toString();
        }
        removed += 1;
      } else {
        keep.push(row);
      }
    }
    for (let i = blobs.length - 1; i >= 0; i -= 1) {
      if (blobs[i]!.hash === hash) blobs.splice(i, 1);
    }
    blobs.push(...keep);
    return Promise.resolve(
      json({ deleted: true, usedStorage: "0", remainingOwners: keep.length, removed }),
    );
  }

  return Promise.resolve(json({ error: "unhandled", url }, 500));
}

function hasPin(hash: string, npub: string) {
  return blobs.some((row) => row.hash === hash && row.npub === npub);
}

let server: Server;
let base: string;

before(async () => {
  // Provider uploads go through axios, not fetch. The proxy only ever PUTs to
  // the roster URL, so a blanket success is enough here.
  mock.method(axios, "put", async (url: string) => {
    if (!url.startsWith("http://10.44.0.8:3000")) {
      throw new Error(`unexpected provider ${url}`);
    }
    return { status: 200 };
  });
  mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("db-api.test")) return fetchStub(input, init);
    return realFetch(input, init);
  });
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address === "object" && address) base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  mock.restoreAll();
});

function put(body: Buffer, authorization: string) {
  return fetch(`${base}/upload`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      authorization,
    },
    body: new Uint8Array(body),
  });
}

test("a non-paying sender can upload for a paying recipient via a p tag", async () => {
  reset();
  paying(recipient.npub, "1000", "100");
  const body = Buffer.alloc(64, 1);
  const hash = hashOf(body);

  const res = await put(body, auth(sender, "upload", { hash, pins: [recipient.pk] }));

  assert.equal(res.status, 201);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0]!.npub, recipient.npub);
  assert.equal(userFor(recipient.npub)!.usedStorage, "164");
  assert.equal(userFor(sender.npub), null, "the disposable sender is not an account");
});

test("without a p tag a non-paying sender is still refused", async () => {
  reset();
  paying(recipient.npub);
  const body = Buffer.alloc(64, 2);
  const hash = hashOf(body);

  const res = await put(body, auth(sender, "upload", { hash }));

  assert.equal(res.status, 403);
  assert.equal(res.headers.get("x-reason"), "unpaid");
  assert.equal(blobs.length, 0);
});

test("a p tag naming a non-paying pubkey is refused", async () => {
  reset();
  const body = Buffer.alloc(64, 3);
  const hash = hashOf(body);

  const res = await put(body, auth(sender, "upload", { hash, pins: [recipient.pk] }));

  assert.equal(res.status, 403);
  assert.equal(res.headers.get("x-reason"), "unpaid");
  assert.equal((await res.json()).target, recipient.npub);
  assert.equal(blobs.length, 0);
});

test("a p tag naming an over-quota recipient is refused before storing", async () => {
  reset();
  paying(recipient.npub, "100", "90");
  const body = Buffer.alloc(64, 4);
  const hash = hashOf(body);

  const res = await put(body, auth(sender, "upload", { hash, pins: [recipient.pk] }));

  assert.equal(res.status, 403);
  assert.equal(res.headers.get("x-reason"), "quota_exceeded");
  assert.equal(blobs.length, 0);
});

test("multiple p tags pin and bill each recipient", async () => {
  reset();
  paying(recipient.npub, "1000", "0");
  paying(other.npub, "1000", "0");
  const body = Buffer.alloc(64, 5);
  const hash = hashOf(body);

  const res = await put(
    body,
    auth(sender, "upload", { hash, pins: [recipient.pk, other.pk] }),
  );

  assert.equal(res.status, 201);
  assert.deepEqual(
    blobs.map((row) => row.npub).sort(),
    [recipient.npub, other.npub].sort(),
  );
  assert.equal(userFor(recipient.npub)!.usedStorage, "64");
  assert.equal(userFor(other.npub)!.usedStorage, "64");
});

test("HEAD /upload authorizes the p-tag target, not the signer", async () => {
  reset();
  paying(recipient.npub);
  const hash = "b".repeat(64);
  const headers = {
    authorization: auth(sender, "upload", { hash, pins: [recipient.pk] }),
    "x-sha-256": hash,
    "x-content-length": "10",
  };

  const ok = await fetch(`${base}/upload`, { method: "HEAD", headers });
  assert.equal(ok.status, 200);

  users.delete(recipient.npub);
  const refused = await fetch(`${base}/upload`, { method: "HEAD", headers });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("x-reason"), "unpaid");
});

test("re-uploading the same content for the same recipient is not charged twice", async () => {
  reset();
  paying(recipient.npub, "1000", "0");
  const body = Buffer.alloc(64, 6);
  const hash = hashOf(body);
  const authorization = auth(sender, "upload", { hash, pins: [recipient.pk] });

  assert.equal((await put(body, authorization)).status, 201);
  const again = await put(body, authorization);

  assert.equal(again.status, 200);
  assert.equal(blobs.length, 1);
  assert.equal(userFor(recipient.npub)!.usedStorage, "64");
});

test("PUT /pin attributes an already-stored blob to a p-tag recipient", async () => {
  reset();
  paying(recipient.npub, "1000", "0");
  paying(other.npub, "1000", "0");
  const body = Buffer.alloc(64, 7);
  const hash = hashOf(body);
  seedBlob(hash, other.npub, body.length);
  userFor(other.npub)!.usedStorage = String(body.length);

  const res = await fetch(`${base}/pin/${hash}`, {
    method: "PUT",
    headers: { authorization: auth(sender, "pin", { hash, pins: [recipient.pk] }) },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(
    blobs.map((row) => row.npub).sort(),
    [recipient.npub, other.npub].sort(),
  );
  assert.equal(userFor(recipient.npub)!.usedStorage, "64");
  assert.equal((await res.json()).sha256, hash);
});

test("PUT /pin 404s for a blob the server does not store", async () => {
  reset();
  paying(recipient.npub);
  const hash = "c".repeat(64);

  const res = await fetch(`${base}/pin/${hash}`, {
    method: "PUT",
    headers: { authorization: auth(sender, "pin", { hash, pins: [recipient.pk] }) },
  });

  assert.equal(res.status, 404);
});

test("GET /pin reveals only the caller's own pin", async () => {
  reset();
  paying(recipient.npub);
  const body = Buffer.alloc(64, 8);
  const hash = hashOf(body);
  seedBlob(hash, recipient.npub, body.length);
  userFor(recipient.npub)!.usedStorage = String(body.length);

  const mine = await fetch(`${base}/pin/${hash}`, {
    headers: { authorization: auth(recipient, "pin", { hash }) },
  });
  assert.equal(mine.status, 200);
  assert.deepEqual(await mine.json(), {
    sha256: hash,
    pinned: Math.floor(new Date(NOW).getTime() / 1000),
  });

  const someoneElse = await fetch(`${base}/pin/${hash}`, {
    headers: { authorization: auth(stranger, "pin", { hash }) },
  });
  assert.equal(someoneElse.status, 404);
});

test("DELETE removes only the signer's pin", async () => {
  reset();
  paying(recipient.npub);
  paying(other.npub);
  const body = Buffer.alloc(64, 9);
  const hash = hashOf(body);
  seedBlob(hash, recipient.npub, body.length);
  seedBlob(hash, other.npub, body.length);
  userFor(recipient.npub)!.usedStorage = String(body.length);
  userFor(other.npub)!.usedStorage = String(body.length);

  const nonPinner = await fetch(`${base}/${hash}`, {
    method: "DELETE",
    headers: { authorization: auth(stranger, "delete", { hash }) },
  });
  assert.equal(nonPinner.status, 403);

  const removed = await fetch(`${base}/${hash}`, {
    method: "DELETE",
    headers: { authorization: auth(other, "delete", { hash }) },
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(blobs.map((row) => row.npub), [recipient.npub]);
});
