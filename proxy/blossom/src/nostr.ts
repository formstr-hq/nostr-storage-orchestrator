import { verifyEvent, nip19 } from "nostr-tools";

export function getNpub(authHeader: string) {
  const encoded = authHeader.replace(
    "Nostr ",
    ""
  );

  const json = Buffer.from(
    encoded,
    "base64"
  ).toString();

  const event = JSON.parse(json);
  
  if (!verifyEvent(event)) {
    throw new Error("Invalid Nostr signature");
  }

  return nip19.npubEncode(
    event.pubkey
  );
}