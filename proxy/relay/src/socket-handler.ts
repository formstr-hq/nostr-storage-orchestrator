import type { Filter, NostrEvent } from "nostr-tools";
import type { WebSocket, WebSocketServer } from "ws";
import { FrontendSubscriptionManager } from "./frontend-subscriptions.js";
import { getNpubFromPubkey, verifyNip42AuthEvent } from "./nostr.js";
import { closedMessage, normalizeReason, okMessage, validateSubscriptionId } from "./protocol.js";
import type { EventPublicationService } from "./publication.js";
import type { RelaySocketState } from "./server-types.js";
import { sendJson, validateEvent } from "./socket-utils.js";

export function registerRelaySocketHandlers(
  wss: WebSocketServer,
  relayUrl: string,
  publicationService: EventPublicationService,
  subscriptions: FrontendSubscriptionManager,
): void {
  const socketStates = new Map<WebSocket, RelaySocketState>();

  wss.on("connection", (socket) => {
    const state = getSocketState(socketStates, socket);
    const challenge = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sendJson(socket, ["AUTH", challenge]);

    socket.on("message", async (raw) => {
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        sendJson(socket, ["NOTICE", "invalid: malformed relay message"]);
        return;
      }

      if (!Array.isArray(payload)) {
        sendJson(socket, ["NOTICE", "invalid: malformed relay message"]);
        return;
      }

      const [messageType, ...rest] = payload as unknown[];
      try {
        if (messageType === "AUTH") {
          handleAuth(socket, state, rest[0] as NostrEvent, challenge, relayUrl);
          return;
        }

        if (messageType === "EVENT") {
          const event = rest[0] as NostrEvent;
          validateEvent(event);
          if (!state.npub || !state.pubkey) {
            sendJson(socket, okMessage(event.id, false, "auth-required: authenticate before publishing"));
            return;
          }
          sendJson(socket, await publicationService.publish(event, state.npub));
          return;
        }

        if (messageType === "REQ") {
          const [rawSubId, ...filters] = rest as [unknown, ...Filter[]];
          const validation = validateSubscriptionId(rawSubId);
          if (!validation.valid) {
            if (typeof rawSubId === "string" && rawSubId.length > 0) {
              sendJson(socket, closedMessage(rawSubId, validation.reason));
            } else {
              sendJson(socket, ["NOTICE", validation.reason]);
            }
            return;
          }

          if (state.subscriptions.has(validation.subId)) {
            subscriptions.close(state, validation.subId);
          }
          subscriptions.start(socket, state, validation.subId, filters);
          return;
        }

        if (messageType === "CLOSE" && typeof rest[0] === "string") {
          subscriptions.close(state, rest[0]);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "error: internal server error";
        sendJson(socket, ["NOTICE", normalizeReason(reason)]);
      }
    });

    socket.on("close", () => {
      subscriptions.closeAll(state);
      socketStates.delete(socket);
    });
  });
}

function getSocketState(
  socketStates: Map<WebSocket, RelaySocketState>,
  socket: WebSocket,
): RelaySocketState {
  let state = socketStates.get(socket);
  if (!state) {
    state = { subscriptions: new Map(), generationCounter: 0 };
    socketStates.set(socket, state);
  }
  return state;
}

function handleAuth(
  socket: WebSocket,
  state: RelaySocketState,
  authEvent: NostrEvent,
  challenge: string,
  relayUrl: string,
): void {
  try {
    const pubkey = verifyNip42AuthEvent(authEvent, challenge, relayUrl);
    state.pubkey = pubkey;
    state.npub = getNpubFromPubkey(pubkey);
    sendJson(socket, okMessage(authEvent.id, true));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid: authentication failed";
    sendJson(socket, okMessage(authEvent.id, false, reason));
  }
}
