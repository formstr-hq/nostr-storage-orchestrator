import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools";
import { RelayPool } from "../src/relay.js";
import { relayUrlsEquivalent, verifyNip42AuthEvent } from "../src/nostr.js";
import { normalizeReason, validateSubscriptionId } from "../src/protocol.js";
import { createRelayServer } from "../src/server.js";
import { loadRelayConfig, type RelayConfig } from "../src/config.js";
import { RelayTestClient, startFakeBackend, wait, type FakeBackend } from "./helpers.js";

function sign(sk: Uint8Array, template: EventTemplate): NostrEvent {
  return finalizeEvent(template, sk);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await wait(10);
  }
}

describe("RelayPool subscriptions", () => {
  let backends: FakeBackend[] = [];
  let pools: RelayPool[] = [];

  afterEach(async () => {
    for (const pool of pools) {
      pool.closeAll();
    }
    pools = [];
    for (const backend of backends) {
      await backend.close();
    }
    backends = [];
  });

  function trackPool(pool: RelayPool): RelayPool {
    pools.push(pool);
    return pool;
  }

  it("forwards events after backend EOSE", async () => {
    const backend = await startFakeBackend({ autoEose: true, eoseDelayMs: 0 });
    backends.push(backend);
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const note = sign(sk, { kind: 1, created_at: nowSeconds(), tags: [], content: "live-after-eose" });

    const pool = trackPool(new RelayPool({
      relays: [backend.url],
      initialEoseTimeoutMs: 1000,
      publishAckTimeoutMs: 1000,
      connectTimeoutMs: 1000,
    }));

    const events: NostrEvent[] = [];
    let eoseCount = 0;
    const handle = pool.subscribe(
      [{ kinds: [1], authors: [pubkey] }],
      {
        onEvent: (event) => events.push(event),
        onBackendInitialSettled: () => {
          eoseCount += 1;
        },
        onBackendClosed: () => undefined,
      },
      { targetRelays: [backend.url] },
    );

    await handle.initialSync;
    await wait(20);
    const backendSubId = [...backend.subscriptions.keys()][0];
    assert.ok(backendSubId);
    backend.sendEose(backendSubId);
    await wait(20);
    backend.sendEvent(backendSubId, note);
    await wait(50);

    assert.equal(eoseCount, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.id, note.id);
    handle.close();
  });

  it("aggregates EOSE across two backends exactly once", async () => {
    const backendA = await startFakeBackend({ autoEose: false });
    const backendB = await startFakeBackend({ autoEose: false });
    backends.push(backendA, backendB);

    const pool = trackPool(new RelayPool({
      relays: [backendA.url, backendB.url],
      initialEoseTimeoutMs: 1000,
      connectTimeoutMs: 1000,
    }));

    const handle = pool.subscribe(
      [{ kinds: [1] }],
      {
        onEvent: () => undefined,
        onBackendInitialSettled: () => undefined,
        onBackendClosed: () => undefined,
      },
      { targetRelays: [backendA.url, backendB.url] },
    );

    await handle.initialSync;
    await wait(50);
    const subA = [...backendA.subscriptions.keys()][0];
    const subB = [...backendB.subscriptions.keys()][0];
    assert.ok(subA, "expected backend A subscription");
    assert.ok(subB, "expected backend B subscription");
    backendA.sendEose(subA);
    backendB.sendEose(subB);
    await wait(30);
    assert.equal(handle.getBackendStatuses().filter((entry) => entry.status === "eose").length, 2);
    handle.close();
  });

  it("does not terminate healthy subscription when another backend times out", async () => {
    const fast = await startFakeBackend({ autoEose: false });
    const slow = await startFakeBackend({ autoEose: false });
    backends.push(fast, slow);

    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const note = sign(sk, { kind: 1, created_at: nowSeconds(), tags: [], content: "still-live" });

    const pool = trackPool(new RelayPool({
      relays: [fast.url, slow.url],
      initialEoseTimeoutMs: 80,
      connectTimeoutMs: 1000,
    }));

    const events: NostrEvent[] = [];
    const handle = pool.subscribe(
      [{ kinds: [1], authors: [pubkey] }],
      {
        onEvent: (event) => events.push(event),
        onBackendInitialSettled: () => undefined,
        onBackendClosed: () => undefined,
      },
      { targetRelays: [fast.url, slow.url] },
    );

    await wait(50);
    const fastSub = [...fast.subscriptions.keys()][0];
    fast.sendEose(fastSub!);
    await wait(120);
    fast.sendEvent(fastSub!, note);
    await wait(50);

    assert.equal(events.length, 1);
    handle.close();
  });

  it("handles backend CLOSED without hanging and closes frontend when all backends close", async () => {
    const backend = await startFakeBackend({ autoEose: false });
    backends.push(backend);

    const pool = trackPool(new RelayPool({
      relays: [backend.url],
      initialEoseTimeoutMs: 500,
      connectTimeoutMs: 1000,
    }));

    let closedReason = "";
    const handle = pool.subscribe(
      [{ kinds: [1] }],
      {
        onEvent: () => undefined,
        onBackendInitialSettled: () => undefined,
        onBackendClosed: (_relay, _backendSubId, reason) => {
          closedReason = reason;
        },
      },
      { targetRelays: [backend.url] },
    );

    await wait(30);
    const subId = [...backend.subscriptions.keys()][0];
    backend.sendClosed(subId!, "restricted: query not allowed");
    await wait(30);
    assert.match(closedReason, /restricted:/);
    handle.close();
  });

  it("replaces duplicate frontend subscriptions and ignores stale events", async () => {
    const backend = await startFakeBackend({ autoEose: false });
    backends.push(backend);

    const pool = trackPool(new RelayPool({
      relays: [backend.url],
      initialEoseTimeoutMs: 500,
      connectTimeoutMs: 1000,
    }));

    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const oldNote = sign(sk, { kind: 1, created_at: nowSeconds(), tags: [], content: "old" });
    const newNote = sign(sk, { kind: 1, created_at: nowSeconds(), tags: [], content: "new" });

    const events: NostrEvent[] = [];
    const first = pool.subscribe(
      [{ kinds: [1], authors: [pubkey] }],
      {
        onEvent: () => undefined,
        onBackendInitialSettled: () => undefined,
        onBackendClosed: () => undefined,
      },
      { targetRelays: [backend.url], generation: 0 },
    );

    await wait(30);
    const oldSubId = [...backend.subscriptions.keys()][0]!;
    first.suppress();
    first.close();

    const second = pool.subscribe(
      [{ kinds: [1], authors: [pubkey] }],
      {
        onEvent: (event) => {
          events.push(event);
        },
        onBackendInitialSettled: () => undefined,
        onBackendClosed: () => undefined,
      },
      { targetRelays: [backend.url], generation: 1 },
    );

    await second.initialSync;
    await wait(30);
    const newSubId = [...backend.subscriptions.keys()].find((id) => id !== oldSubId);
    assert.ok(newSubId, "expected replacement backend subscription");
    backend.sendEvent(oldSubId, oldNote);
    backend.sendEvent(newSubId!, newNote);
    await wait(50);

    assert.equal(events.length, 1);
    assert.equal(events[0]?.content, "new");
    second.close();
  });

  it("client close sends backend CLOSE and cleans up", async () => {
    const backend = await startFakeBackend({ autoEose: false });
    backends.push(backend);

    const pool = trackPool(new RelayPool({
      relays: [backend.url],
      initialEoseTimeoutMs: 500,
      connectTimeoutMs: 1000,
    }));
    const handle = pool.subscribe(
      [{ kinds: [1] }],
      {
        onEvent: () => undefined,
        onBackendInitialSettled: () => undefined,
        onBackendClosed: () => undefined,
      },
      { targetRelays: [backend.url] },
    );

    await wait(30);
    const subId = [...backend.subscriptions.keys()][0];
    assert.ok(subId);
    handle.close();
    await wait(30);
    assert.equal(backend.subscriptions.has(subId!), false);
  });

  it("backend socket closure rejects pending publication operations", async () => {
    const backend = await startFakeBackend({ autoOk: false });
    backends.push(backend);

    const pool = trackPool(new RelayPool({
      relays: [backend.url],
      publishAckTimeoutMs: 200,
      connectTimeoutMs: 1000,
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 10,
      reconnectJitterRatio: 0,
    }));
    const sk = generateSecretKey();
    const note = sign(sk, { kind: 1, created_at: nowSeconds(), tags: [], content: "pending" });

    const publishPromise = pool.publish(note, [backend.url]);
    await wait(30);
    backend.closeSocket();
    const results = await publishPromise;
    assert.equal(results[0]?.accepted, false);
    await waitForCondition(() => backend.connectionCount === 2);
  });

  it("reconnects and restores an active subscription after the backend socket drops", async () => {
    const backend = await startFakeBackend({
      authChallenge: true,
      requireAuth: true,
      autoEose: false,
    });
    backends.push(backend);
    const pool = trackPool(new RelayPool({
      relays: [backend.url],
      backendAuthSecretKey: generateSecretKey(),
      initialEoseTimeoutMs: 1000,
      connectTimeoutMs: 1000,
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 10,
      reconnectJitterRatio: 0,
    }));
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const note = sign(sk, {
      kind: 1,
      created_at: nowSeconds(),
      tags: [],
      content: "after-reconnect",
    });
    const events: NostrEvent[] = [];
    let backendClosedCount = 0;
    const handle = pool.subscribe(
      [{ kinds: [1], authors: [pubkey] }],
      {
        onEvent: (event) => events.push(event),
        onBackendInitialSettled: () => undefined,
        onBackendClosed: () => {
          backendClosedCount += 1;
        },
      },
      { targetRelays: [backend.url] },
    );

    await handle.initialSync;
    await waitForCondition(() => backend.subscriptions.size === 1);
    const backendSubId = [...backend.subscriptions.keys()][0]!;
    backend.sendEose(backendSubId);
    await wait(20);

    backend.closeSocket();
    await waitForCondition(
      () => backend.connectionCount === 2 && backend.subscriptions.has(backendSubId),
    );
    backend.sendEvent(backendSubId, note);
    await waitForCondition(() => events.length === 1);

    assert.equal(events[0]?.id, note.id);
    assert.equal(backendClosedCount, 0);
    handle.close();
  });
});

describe("RelayPool publication", () => {
  let backends: FakeBackend[] = [];
  let pools: RelayPool[] = [];

  afterEach(async () => {
    for (const pool of pools) {
      pool.closeAll();
    }
    pools = [];
    for (const backend of backends) {
      await backend.close();
    }
    backends = [];
  });

  function trackPool(pool: RelayPool): RelayPool {
    pools.push(pool);
    return pool;
  }

  it("rejects backend OK false and preserves reason", async () => {
    const sk = generateSecretKey();
    const note = sign(sk, { kind: 1, created_at: nowSeconds(), tags: [], content: "reject" });
    const backend = await startFakeBackend({
      autoOk: false,
      okResponses: { [note.id]: { accepted: false, reason: "blocked: event rejected" } },
    });
    backends.push(backend);

    const pool = trackPool(new RelayPool({ relays: [backend.url], publishAckTimeoutMs: 500, connectTimeoutMs: 1000 }));
    const results = await pool.publish(note, [backend.url]);
    assert.equal(results[0]?.accepted, false);
    assert.match(results[0]?.message ?? "", /blocked:/);
  });

  it("accepts backend OK true", async () => {
    const backend = await startFakeBackend({ autoOk: true });
    backends.push(backend);
    const sk = generateSecretKey();
    const note = sign(sk, { kind: 1, created_at: nowSeconds(), tags: [], content: "accept" });
    const pool = trackPool(new RelayPool({ relays: [backend.url], publishAckTimeoutMs: 500, connectTimeoutMs: 1000 }));
    const results = await pool.publish(note, [backend.url]);
    assert.equal(results[0]?.accepted, true);
  });

  it("completes backend AUTH before sending the first event", async () => {
    const backend = await startFakeBackend({
      authChallenge: true,
      requireAuth: true,
      autoOk: true,
    });
    backends.push(backend);
    const sk = generateSecretKey();
    const note = sign(sk, { kind: 1, created_at: nowSeconds(), tags: [], content: "authenticated" });
    const pool = trackPool(new RelayPool({
      relays: [backend.url],
      backendAuthSecretKey: generateSecretKey(),
      publishAckTimeoutMs: 500,
      connectTimeoutMs: 1000,
    }));

    const results = await pool.publish(note, [backend.url]);
    assert.equal(results[0]?.accepted, true);
  });

  it("mixed backend publication results cannot produce false success", async () => {
    const sk = generateSecretKey();
    const note = sign(sk, { kind: 1, created_at: nowSeconds(), tags: [], content: "mixed" });
    const acceptBackend = await startFakeBackend({ autoOk: true });
    const rejectBackend = await startFakeBackend({
      autoOk: false,
      okResponses: { [note.id]: { accepted: false, reason: "blocked: nope" } },
    });
    backends.push(acceptBackend, rejectBackend);

    const pool = trackPool(new RelayPool({
      relays: [acceptBackend.url, rejectBackend.url],
      publishAckTimeoutMs: 500,
      connectTimeoutMs: 1000,
    }));
    const results = await pool.publish(note, [acceptBackend.url, rejectBackend.url]);
    const accepted = results.filter((entry) => entry.accepted);
    assert.equal(accepted.length, 1);
    assert.equal(results.length, 2);
  });
});

describe("protocol and NIP-42", () => {
  it("rejects backend authentication keys that are not 32 bytes", () => {
    const previous = process.env.BACKEND_AUTH_SECRET_KEY;
    process.env.BACKEND_AUTH_SECRET_KEY = "00";
    try {
      assert.throws(() => loadRelayConfig(), /32-byte hex string/);
    } finally {
      if (previous === undefined) {
        delete process.env.BACKEND_AUTH_SECRET_KEY;
      } else {
        process.env.BACKEND_AUTH_SECRET_KEY = previous;
      }
    }
  });

  it("normalizes reasons without double prefix", () => {
    assert.equal(normalizeReason("invalid: already prefixed"), "invalid: already prefixed");
    assert.equal(normalizeReason("bad things"), "error: bad things");
  });

  it("validates subscription ids", () => {
    assert.equal(validateSubscriptionId("abc").valid, true);
    assert.equal(validateSubscriptionId("").valid, false);
    assert.equal(validateSubscriptionId("x".repeat(65)).valid, false);
  });

  it("accepts equivalent normalized relay URLs", () => {
    assert.equal(relayUrlsEquivalent("ws://Relay.Example.com", "WS://relay.example.com:80/"), true);
    assert.equal(relayUrlsEquivalent("wss://relay.example.com:443", "wss://relay.example.com"), true);
  });

  it("rejects different hostname, port, or invalid URL", () => {
    assert.equal(relayUrlsEquivalent("ws://a.example.com", "ws://b.example.com"), false);
    assert.equal(relayUrlsEquivalent("ws://relay.example.com:8007", "ws://relay.example.com:8008"), false);
    assert.throws(() => relayUrlsEquivalent("not-a-url", "ws://relay.example.com"));
  });

  it("returns OK false with invalid reason for bad frontend AUTH", () => {
    const sk = generateSecretKey();
    const authEvent = sign(sk, {
      kind: 22242,
      created_at: nowSeconds(),
      tags: [
        ["relay", "ws://wrong.example.com"],
        ["challenge", "challenge"],
      ],
      content: "",
    });
    assert.throws(
      () => verifyNip42AuthEvent(authEvent, "challenge", "ws://localhost:8007"),
      /invalid:/,
    );
  });
});

describe("relay server integration", () => {
  let backends: FakeBackend[] = [];
  let relayServer: Awaited<ReturnType<typeof createRelayServer>> | undefined;

  afterEach(async () => {
    if (relayServer) {
      await relayServer.close();
      relayServer = undefined;
    }
    for (const backend of backends) {
      await backend.close();
    }
    backends = [];
  });

  async function startRelayWithBackends(
    backendUrls: string[],
    overrides: Partial<RelayConfig> = {},
  ): Promise<{ port: number; publicUrl: string }> {
    const relayConfig: RelayConfig = {
      relayPort: 0,
      publicUrl: "ws://127.0.0.1:0",
      backendRelays: backendUrls,
      initialEoseTimeoutMs: 200,
      publishAckTimeoutMs: 200,
      software: "test-relay",
      version: "test",
      ...overrides,
    };
    relayServer = createRelayServer({ relayConfig });
    const port = await relayServer.listen();
    relayConfig.publicUrl = `ws://127.0.0.1:${port}`;
    return { port, publicUrl: relayConfig.publicUrl };
  }

  it("sends exactly one frontend EOSE after all backends settle", async () => {
    const backendA = await startFakeBackend({ autoEose: false });
    const backendB = await startFakeBackend({ autoEose: false });
    backends.push(backendA, backendB);
    const { port } = await startRelayWithBackends([backendA.url, backendB.url]);

    const client = new RelayTestClient(`ws://127.0.0.1:${port}`);
    await client.connected();
    await client.waitFor((message) => message[0] === "AUTH");
    client.send(["REQ", "sub-1", { kinds: [1] }]);
    await wait(40);
    const subA = [...backendA.subscriptions.keys()][0]!;
    const subB = [...backendB.subscriptions.keys()][0]!;
    backendA.sendEose(subA);
    const before = await client.drain((message) => message[0] === "EOSE", 100);
    assert.equal(before.length, 0);
    backendB.sendEose(subB);
    const [, subId] = await client.waitFor((message) => message[0] === "EOSE");
    assert.equal(subId, "sub-1");
    const after = await client.drain((message) => message[0] === "EOSE", 100);
    assert.equal(after.length, 0);
    client.close();
  });

  it("live subscription receives event after EOSE", async () => {
    const backend = await startFakeBackend({ autoEose: false });
    backends.push(backend);
    const { port, publicUrl } = await startRelayWithBackends([backend.url]);

    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const client = new RelayTestClient(`ws://127.0.0.1:${port}`);
    await client.connected();
    const [, challenge] = await client.waitFor((message) => message[0] === "AUTH");
    const authEvent = sign(sk, {
      kind: 22242,
      created_at: nowSeconds(),
      tags: [
        ["relay", publicUrl],
        ["challenge", challenge as string],
      ],
      content: "",
    });
    client.send(["AUTH", authEvent]);
    await client.waitFor((message) => message[0] === "OK" && message[1] === authEvent.id);

    client.send(["REQ", "live-sub", { kinds: [1], authors: [pubkey] }]);
    await wait(40);
    const backendSubId = [...backend.subscriptions.keys()][0]!;
    backend.sendEose(backendSubId);
    await client.waitFor((message) => message[0] === "EOSE");

    const liveNote = sign(sk, {
      kind: 1,
      created_at: nowSeconds(),
      tags: [],
      content: `live-${Date.now()}`,
    });
    backend.sendEvent(backendSubId, liveNote);
    const [, , event] = await client.waitFor((message) => message[0] === "EVENT");
    assert.equal((event as NostrEvent).id, liveNote.id);

    client.send(["CLOSE", "live-sub"]);
    const notices = await client.drain((message) => message[0] === "NOTICE", 100);
    assert.equal(notices.length, 0);
    client.close();
  });

  it("rejects invalid subscription id with CLOSED", async () => {
    const backend = await startFakeBackend();
    backends.push(backend);
    const { port } = await startRelayWithBackends([backend.url]);
    const client = new RelayTestClient(`ws://127.0.0.1:${port}`);
    await client.connected();
    await client.waitFor((message) => message[0] === "AUTH");
    client.send(["REQ", "", { kinds: [1] }]);
    const notice = await client.waitFor((message) => message[0] === "NOTICE");
    assert.match(String(notice[1]), /invalid:/);

    client.send(["REQ", "x".repeat(65), { kinds: [1] }]);
    const [, subId, reason] = await client.waitFor((message) => message[0] === "CLOSED");
    assert.equal(subId, "x".repeat(65));
    assert.match(String(reason), /invalid:/);
    client.close();
  });

  it("returns CLOSED when no backend relays are configured", async () => {
    relayServer = createRelayServer({
      relayConfig: {
        relayPort: 0,
        publicUrl: "ws://127.0.0.1:0",
        backendRelays: [],
        initialEoseTimeoutMs: 200,
        publishAckTimeoutMs: 200,
        software: "test",
        version: "test",
      },
    });
    const port = await relayServer.listen();
    const client = new RelayTestClient(`ws://127.0.0.1:${port}`);
    await client.connected();
    await client.waitFor((message) => message[0] === "AUTH");
    client.send(["REQ", "orphan", { kinds: [1] }]);
    const [, , reason] = await client.waitFor((message) => message[0] === "CLOSED");
    assert.match(String(reason), /error: no backend relays are available/);
    client.close();
  });

  it("deduplicates events from multiple backends", async () => {
    const backendA = await startFakeBackend({ autoEose: false });
    const backendB = await startFakeBackend({ autoEose: false });
    backends.push(backendA, backendB);
    const { port } = await startRelayWithBackends([backendA.url, backendB.url]);

    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const note = sign(sk, { kind: 1, created_at: nowSeconds(), tags: [], content: "dedup" });

    const client = new RelayTestClient(`ws://127.0.0.1:${port}`);
    await client.connected();
    await client.waitFor((message) => message[0] === "AUTH");
    client.send(["REQ", "dedup-sub", { kinds: [1], authors: [pubkey] }]);
    await wait(40);
    const subA = [...backendA.subscriptions.keys()][0]!;
    const subB = [...backendB.subscriptions.keys()][0]!;
    backendA.sendEvent(subA, note);
    backendB.sendEvent(subB, note);
    backendA.sendEose(subA);
    backendB.sendEose(subB);
    const events = await client.drain((message) => message[0] === "EVENT", 300);
    assert.equal(events.length, 1);
    client.close();
  });

  it("does not forward invalid backend events", async () => {
    const backend = await startFakeBackend({ autoEose: false });
    backends.push(backend);
    const { port } = await startRelayWithBackends([backend.url]);

    const sk = generateSecretKey();
    const bad = sign(sk, { kind: 1, created_at: nowSeconds(), tags: [], content: "bad" });
    const tampered = { ...bad, id: "0".repeat(64) } as NostrEvent;

    const client = new RelayTestClient(`ws://127.0.0.1:${port}`);
    await client.connected();
    await client.waitFor((message) => message[0] === "AUTH");
    client.send(["REQ", "validate-sub", { kinds: [1] }]);
    await wait(40);
    const subId = [...backend.subscriptions.keys()][0]!;
    backend.sendEvent(subId, tampered);
    backend.sendEose(subId);
    await client.waitFor((message) => message[0] === "EOSE");
    const events = await client.drain((message) => message[0] === "EVENT", 150);
    assert.equal(events.length, 0);
    client.close();
  });

  it("sends frontend CLOSED when all backends close", async () => {
    const backendA = await startFakeBackend({ autoEose: false });
    const backendB = await startFakeBackend({ autoEose: false });
    backends.push(backendA, backendB);
    const { port } = await startRelayWithBackends([backendA.url, backendB.url]);

    const client = new RelayTestClient(`ws://127.0.0.1:${port}`);
    await client.connected();
    await client.waitFor((message) => message[0] === "AUTH");
    client.send(["REQ", "close-sub", { kinds: [1] }]);
    await wait(40);
    const subA = [...backendA.subscriptions.keys()][0]!;
    const subB = [...backendB.subscriptions.keys()][0]!;
    backendA.sendClosed(subA, "error: backend a closed");
    backendB.sendClosed(subB, "error: backend b closed");
    const [, subId, reason] = await client.waitFor((message) => message[0] === "CLOSED");
    assert.equal(subId, "close-sub");
    assert.match(String(reason), /error:/);
    client.close();
  });

  it("closing frontend socket closes backend subscriptions", async () => {
    const backend = await startFakeBackend({ autoEose: false });
    backends.push(backend);
    const { port } = await startRelayWithBackends([backend.url]);

    const client = new RelayTestClient(`ws://127.0.0.1:${port}`);
    await client.connected();
    await client.waitFor((message) => message[0] === "AUTH");
    client.send(["REQ", "socket-close", { kinds: [1] }]);
    await wait(40);
    const subId = [...backend.subscriptions.keys()][0]!;
    client.close();
    await wait(50);
    assert.equal(backend.subscriptions.has(subId), false);
  });
});

describe("NIP-11", () => {
  it("returns metadata with content type and CORS headers", async () => {
    const relayServer = createRelayServer({
      relayConfig: {
        relayPort: 0,
        publicUrl: "ws://127.0.0.1:0",
        backendRelays: ["ws://127.0.0.1:1"],
        initialEoseTimeoutMs: 200,
        publishAckTimeoutMs: 200,
        software: "test-relay",
        version: "1.2.3",
      },
    });
    const port = await relayServer.listen();
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Accept: "application/nostr+json" },
    });
    assert.equal(response.ok, true);
    assert.match(response.headers.get("content-type") ?? "", /application\/nostr\+json/);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const body = (await response.json()) as {
      supported_nips: number[];
      limitation: { restricted_writes: boolean };
    };
    assert.deepEqual(body.supported_nips, [1, 11, 42]);
    assert.equal(body.limitation.restricted_writes, true);
    await relayServer.close();
  });
});
