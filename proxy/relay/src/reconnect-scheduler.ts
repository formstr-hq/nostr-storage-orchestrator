import type { RelayLogger, RelayPoolOptions } from "./relay-types.js";

export class ReconnectScheduler {
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly attempts = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(options: RelayPoolOptions, private readonly logger: RelayLogger) {
    this.initialDelayMs = Math.max(0, options.reconnectInitialDelayMs ?? 250);
    this.maxDelayMs = Math.max(this.initialDelayMs, options.reconnectMaxDelayMs ?? 30_000);
    this.jitterRatio = Math.min(1, Math.max(0, options.reconnectJitterRatio ?? 0.2));
  }

  isScheduled(relay: string): boolean {
    return this.timers.has(relay);
  }

  reset(relay: string): void {
    this.attempts.delete(relay);
  }

  schedule(relay: string, reason: string, reconnect: () => void): void {
    if (this.stopped || this.timers.has(relay)) {
      return;
    }

    const attempt = (this.attempts.get(relay) ?? 0) + 1;
    this.attempts.set(relay, attempt);
    const exponentialDelay = Math.min(
      this.initialDelayMs * 2 ** (attempt - 1),
      this.maxDelayMs,
    );
    const jitter = exponentialDelay * this.jitterRatio * (Math.random() * 2 - 1);
    const delayMs = Math.max(0, Math.round(exponentialDelay + jitter));
    const timer = setTimeout(() => {
      this.timers.delete(relay);
      reconnect();
    }, delayMs);
    this.timers.set(relay, timer);
    this.logger.warn?.("backend relay reconnect scheduled", {
      relay,
      attempt,
      delayMs,
      reason,
    });
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.attempts.clear();
  }
}
