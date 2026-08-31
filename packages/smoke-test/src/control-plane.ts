import { createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

function identity() {
  const secret = generateSecretKey();
  process.stdout.write(JSON.stringify({
    nsec: nip19.nsecEncode(secret),
    npub: nip19.npubEncode(getPublicKey(secret)),
  }));
}

function secretFromEnv(): Uint8Array {
  const encoded = process.env.CONTROL_PLANE_NSEC;
  if (!encoded) throw new Error("CONTROL_PLANE_NSEC is required");
  const decoded = nip19.decode(encoded);
  if (decoded.type !== "nsec") throw new Error("CONTROL_PLANE_NSEC must be an nsec");
  return decoded.data;
}

async function request() {
  const method = (process.argv[3] ?? "").toUpperCase();
  const url = process.argv[4];
  if (!url || (method !== "GET" && method !== "POST")) {
    throw new Error("usage: control-plane request GET|POST <url> [json-body]");
  }
  const body = method === "POST" ? (process.argv[5] ?? "{}") : undefined;
  if (body !== undefined) JSON.parse(body);
  const tags = [["u", url], ["method", method]];
  if (body !== undefined) {
    tags.push(["payload", createHash("sha256").update(body).digest("hex")]);
  }
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  }, secretFromEnv());
  const authorization = `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
  const response = await fetch(url, {
    method,
    headers: {
      authorization,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body,
    redirect: "error",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`control plane returned HTTP ${response.status}: ${text}`);
  }
  process.stdout.write(text);
}

const command = process.argv[2];
if (command === "identity") {
  identity();
} else if (command === "request") {
  await request();
} else {
  throw new Error("usage: control-plane identity|request");
}
