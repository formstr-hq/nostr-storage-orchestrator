import type { NostrEvent } from "nostr-tools";
import type { WebSocket } from "ws";

export type BackendSubStatus = "pending" | "eose" | "timed-out" | "failed" | "closed";

export type PublishResult = {
  relay: string;
  accepted: boolean;
  message: string;
};

export type BackendSubscriptionRef = {
  relay: string;
  backendSubId: string;
  status: BackendSubStatus;
  reason?: string;
};

export type RelayLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};

export type RelayPoolOptions = {
  relays?: string[];
  initialEoseTimeoutMs?: number;
  publishAckTimeoutMs?: number;
  connectTimeoutMs?: number;
  backendAuthProbeMs?: number;
  wsFactory?: (url: string) => WebSocket;
  logger?: RelayLogger;
  backendAuthSecretKey?: Uint8Array;
};

export type BackendSubscription = {
  backendSubId: string;
  relay: string;
  generation: number;
  initialStatus: BackendSubStatus;
  initialReason?: string;
  initialSettled: boolean;
  closed: boolean;
  onEvent: (event: NostrEvent) => void;
  onInitialSettled: (status: BackendSubStatus, reason?: string) => void;
  onBackendClosed: (reason: string) => void;
  eoseTimer?: ReturnType<typeof setTimeout>;
};

export type PendingOk = {
  resolve: (result: { accepted: boolean; message: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type RelayConnection = {
  url: string;
  socket: WebSocket;
  pendingOk: Map<string, PendingOk>;
  subscriptions: Map<string, BackendSubscription>;
  authUnavailable: boolean;
  authUnavailableReason?: string;
};

export type SubscriptionCallbacks = {
  onEvent: (event: NostrEvent, relay: string) => void;
  onBackendInitialSettled: (
    relay: string,
    backendSubId: string,
    status: BackendSubStatus,
    reason?: string,
  ) => void;
  onBackendClosed: (relay: string, backendSubId: string, reason: string) => void;
};

export type SubscriptionHandle = {
  generation: number;
  backendSubs: BackendSubscriptionRef[];
  initialSync: Promise<void>;
  close: () => void;
  suppress: () => void;
  getBackendStatuses: () => BackendSubscriptionRef[];
};
