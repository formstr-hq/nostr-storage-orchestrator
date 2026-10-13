// Publishes a unique kind-1 event to a nostr relay and prints a SQL query
// for the pgweb explorer (dbase.stg.formstr.app) to find that event on the
// mesh-PG provider the relay's writes are dispatched to.
//
//   pnpm --filter @orchestrator/smoke-test publish-event
//   RELAY_URL=wss://relay.formstr.app pnpm --filter @orchestrator/smoke-test publish-event
//
// The event id is the relay-visible hex id; the same id is the events.event_id
// primary key in meshdb, which is bytea — hence decode(<hex>, 'hex') in SQL.

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

const RELAY_URL = process.env.RELAY_URL ?? process.argv[2] ?? "wss://relay.formstr.app";
const WAIT_MS = Number(process.env.WAIT_MS ?? 20_000);

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const content = `mesh-pg sync check ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 10)}`;
const event = finalizeEvent(
  { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content },
  sk,
);

console.log(`relay:    ${RELAY_URL}`);
console.log(`event_id: ${event.id}`);
console.log(`pubkey:   ${pubkey}`);
console.log(`npub:     ${nip19.npubEncode(pubkey)}`);
console.log(`content:  ${content}`);
console.log("");

function publish(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out waiting for the relay to accept the event (${WAIT_MS}ms)`));
    }, WAIT_MS);
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`websocket error connecting to ${RELAY_URL}`));
    };
    ws.onopen = () => ws.send(JSON.stringify(["EVENT", event]));
    ws.onmessage = (message) => {
      const msg = JSON.parse(message.data as string) as unknown[];
      if (msg[0] === "OK" && msg[1] === event.id) {
        clearTimeout(timer);
        ws.close();
        console.log(`relay accepted: ${msg[2]} ${String(msg[3] ?? "")}`.trim());
        resolve(msg[2] === true);
      } else if (msg[0] === "NOTICE") {
        console.error(`relay NOTICE: ${msg[1]}`);
      }
    };
  });
}

// The relay's read path resolves through pg-gateway -> provider, so a REQ
// immediately after OK can race the ~200ms dispatch: retry until it appears.
function readBack(): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(RELAY_URL);
    const deadline = Date.now() + WAIT_MS;
    let req = 0;
    const timer = setTimeout(() => {
      ws.close();
      resolve(false);
    }, WAIT_MS);
    ws.onerror = () => {
      clearTimeout(timer);
      ws.close();
      resolve(false);
    };
    ws.onopen = () => ws.send(JSON.stringify(["REQ", "read-back", { ids: [event.id] }]));
    ws.onmessage = (message) => {
      const msg = JSON.parse(message.data as string) as unknown[];
      if (msg[0] === "EVENT" && (msg[2] as { id?: string })?.id === event.id) {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      } else if (msg[0] === "EOSE" && Date.now() < deadline) {
        req += 1;
        setTimeout(() => ws.send(JSON.stringify(["REQ", `read-back-${req}`, { ids: [event.id] }])), 1000);
      }
    };
  });
}

const accepted = await publish();
if (!accepted) {
  console.error("relay rejected the event");
  process.exit(1);
}

console.log("");
console.log("run this in pgweb (https://dbase.stg.formstr.app -> Query tab):");
console.log("");
console.log(`  SELECT event_id, event_kind, event_created_at, event_content`);
console.log(`  FROM "events"`);
console.log(`  WHERE event_id = decode('${event.id}', 'hex');`);
console.log("");
console.log("or by content (no bytea decoding):");
console.log("");
console.log(`  SELECT event_id, event_kind, event_created_at, event_content`);
console.log(`  FROM "events"`);
console.log(`  WHERE event_content = '${content}';`);
console.log("");

const confirmed = await readBack();
console.log(
  confirmed
    ? "relay read-back: confirmed (event is already dispatched to the provider)"
    : "relay read-back: not visible yet — it can take a moment; the pgweb query above is the source of truth",
);
