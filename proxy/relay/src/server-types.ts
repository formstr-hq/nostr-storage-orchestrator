import type { Filter } from "nostr-tools";
import type { BoundedEventDedup } from "./dedup.js";
import type { SubscriptionHandle } from "./relay.js";

export type FrontendSubscription = {
  generation: number;
  closed: boolean;
  eoseSent: boolean;
  settledBackends: Set<string>;
  expectedBackends: number;
  handle: SubscriptionHandle | null;
  dedup: BoundedEventDedup;
  filters: Filter[];
  abortController: AbortController;
};

export type RelaySocketState = {
  pubkey?: string;
  npub?: string;
  subscriptions: Map<string, FrontendSubscription>;
  generationCounter: number;
};
