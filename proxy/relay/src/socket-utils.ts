import type { NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";
import { WebSocket } from "ws";

export function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

export function validateEvent(event: NostrEvent): void {
  if (!verifyEvent(event)) {
    throw new Error("invalid: event signature verification failed");
  }
}
