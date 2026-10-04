import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { wrapEvent } from "nostr-tools/nip17";
import { SimplePool } from "nostr-tools/pool";
import { nip19 } from "nostr-tools";

export interface DmSender {
  send(npub: string, subject: string, body: string): Promise<void>;
}

function decodeSecret(nsec: string): Uint8Array {
  if (nsec.startsWith("nsec1")) {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== "nsec") throw new Error("NOTIFY_NSEC is not an nsec");
    return decoded.data;
  }
  throw new Error("NOTIFY_NSEC must be a bech32 nsec");
}

/**
 * NIP-17 DM sender. Best-effort: relays may be unreachable, in which case the
 * caller logs and moves on rather than retrying forever.
 */
export function createDmSender(options: {
  nsec: string | undefined;
  relays: string[];
}): DmSender | null {
  if (!options.nsec) return null;
  const secret = decodeSecret(options.nsec);
  const pool = new SimplePool();

  return {
    async send(npub: string, subject: string, body: string) {
      const decoded = nip19.decode(npub);
      if (decoded.type !== "npub") throw new Error(`not an npub: ${npub}`);
      const recipient = decoded.data;
      const event = wrapEvent(secret, { publicKey: recipient }, `${subject}\n\n${body}`);
      await Promise.any(pool.publish(options.relays, event));
      void getPublicKey(secret);
    },
  };
}

export function notifierNpub(nsec: string | undefined): string | null {
  if (!nsec) return null;
  return nip19.npubEncode(getPublicKey(decodeSecret(nsec)));
}

// Re-exported for tests to construct signed events without a relay.
export { finalizeEvent };
