import type { BackendSubscription } from "./relay-types.js";

export class BackendSubscriptionRegistry {
  private readonly subscriptions = new Map<string, Map<string, BackendSubscription>>();

  register(subscription: BackendSubscription): void {
    let relaySubscriptions = this.subscriptions.get(subscription.relay);
    if (!relaySubscriptions) {
      relaySubscriptions = new Map();
      this.subscriptions.set(subscription.relay, relaySubscriptions);
    }
    relaySubscriptions.set(subscription.backendSubId, subscription);
  }

  has(subscription: BackendSubscription): boolean {
    return this.subscriptions.get(subscription.relay)?.get(subscription.backendSubId) === subscription;
  }

  activeFor(relay: string): BackendSubscription[] {
    return [...(this.subscriptions.get(relay)?.values() ?? [])].filter(
      (subscription) => !subscription.closed,
    );
  }

  close(relay: string, backendSubId: string): void {
    const subscription = this.subscriptions.get(relay)?.get(backendSubId);
    if (subscription) {
      subscription.closed = true;
      if (subscription.eoseTimer) {
        clearTimeout(subscription.eoseTimer);
      }
    }
    this.forget(relay, backendSubId);
  }

  forget(relay: string, backendSubId: string): void {
    const relaySubscriptions = this.subscriptions.get(relay);
    relaySubscriptions?.delete(backendSubId);
    if (relaySubscriptions?.size === 0) {
      this.subscriptions.delete(relay);
    }
  }

  fail(relay: string, reason: string): void {
    const relaySubscriptions = this.subscriptions.get(relay);
    if (!relaySubscriptions) {
      return;
    }
    this.subscriptions.delete(relay);
    for (const subscription of relaySubscriptions.values()) {
      if (subscription.eoseTimer) {
        clearTimeout(subscription.eoseTimer);
      }
      if (!subscription.initialSettled) {
        subscription.onInitialSettled("failed", reason);
      }
      subscription.onBackendClosed(reason);
    }
  }

  closeAll(): void {
    for (const relaySubscriptions of this.subscriptions.values()) {
      for (const subscription of relaySubscriptions.values()) {
        subscription.closed = true;
        if (subscription.eoseTimer) {
          clearTimeout(subscription.eoseTimer);
        }
      }
    }
    this.subscriptions.clear();
  }
}
