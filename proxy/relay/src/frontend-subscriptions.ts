import type { Filter } from "nostr-tools";
import type { WebSocket } from "ws";
import { BoundedEventDedup } from "./dedup.js";
import { isValidForwardableEvent } from "./event-validation.js";
import { closedMessage } from "./protocol.js";
import type { BackendSubStatus, RelayPool } from "./relay.js";
import type { FrontendSubscription, RelaySocketState } from "./server-types.js";
import { sendJson } from "./socket-utils.js";

function isInitialTerminalStatus(status: BackendSubStatus): boolean {
  return status === "eose" || status === "timed-out" || status === "failed" || status === "closed";
}

export class FrontendSubscriptionManager {
  constructor(
    private readonly relayPool: RelayPool,
    private readonly backendRelays: string[],
  ) {}

  start(socket: WebSocket, state: RelaySocketState, subId: string, filters: Filter[]): void {
    if (this.backendRelays.length === 0) {
      sendJson(socket, closedMessage(subId, "error: no backend relays are available"));
      return;
    }

    const generation = ++state.generationCounter;
    const abortController = new AbortController();
    const subscription: FrontendSubscription = {
      generation,
      closed: false,
      eoseSent: false,
      settledBackends: new Set(),
      expectedBackends: this.backendRelays.length,
      handle: null,
      dedup: new BoundedEventDedup(),
      filters,
      abortController,
    };
    state.subscriptions.set(subId, subscription);

    const handle = this.relayPool.subscribe(
      filters,
      {
        onEvent: (event) => {
          const active = this.getActive(state, subId, generation);
          if (!active || !isValidForwardableEvent(event, active.filters) || !active.dedup.add(event.id)) {
            return;
          }
          sendJson(socket, ["EVENT", subId, event]);
        },
        onBackendInitialSettled: (_relay, backendSubId, status) => {
          const active = this.getActive(state, subId, generation);
          if (!active || !isInitialTerminalStatus(status) || active.settledBackends.has(backendSubId)) {
            return;
          }
          active.settledBackends.add(backendSubId);
          this.maybeSendAggregatedEose(socket, subId, active);
        },
        onBackendClosed: (_relay, _backendSubId, reason) => {
          const active = this.getActive(state, subId, generation);
          if (!active?.handle) {
            return;
          }
          const allClosed = active.handle
            .getBackendStatuses()
            .every((entry) => entry.status === "closed" || entry.status === "failed");
          if (allClosed) {
            this.terminate(socket, state, subId, reason);
          }
        },
      },
      {
        targetRelays: this.backendRelays,
        generation,
        signal: abortController.signal,
      },
    );

    subscription.handle = handle;
    subscription.expectedBackends = handle.backendSubs.length;
  }

  close(state: RelaySocketState, subId: string): void {
    const subscription = state.subscriptions.get(subId);
    if (!subscription || subscription.closed) {
      return;
    }
    this.stop(subscription);
    state.subscriptions.delete(subId);
  }

  closeAll(state: RelaySocketState): void {
    for (const subId of [...state.subscriptions.keys()]) {
      this.close(state, subId);
    }
  }

  private getActive(
    state: RelaySocketState,
    subId: string,
    generation: number,
  ): FrontendSubscription | undefined {
    const subscription = state.subscriptions.get(subId);
    return subscription && !subscription.closed && subscription.generation === generation
      ? subscription
      : undefined;
  }

  private maybeSendAggregatedEose(
    socket: WebSocket,
    subId: string,
    subscription: FrontendSubscription,
  ): void {
    if (
      subscription.closed ||
      subscription.eoseSent ||
      subscription.settledBackends.size < subscription.expectedBackends
    ) {
      return;
    }
    subscription.eoseSent = true;
    sendJson(socket, ["EOSE", subId]);
  }

  private terminate(socket: WebSocket, state: RelaySocketState, subId: string, reason: string): void {
    const subscription = state.subscriptions.get(subId);
    if (!subscription || subscription.closed) {
      return;
    }
    this.stop(subscription);
    state.subscriptions.delete(subId);
    sendJson(socket, closedMessage(subId, reason));
  }

  private stop(subscription: FrontendSubscription): void {
    subscription.closed = true;
    subscription.abortController.abort();
    subscription.handle?.suppress();
    subscription.handle?.close();
  }
}
