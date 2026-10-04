/**
 * Minimal fixed-window in-memory rate limiter. Single-instance only, like the
 * NIP-98 replay cache; scaling the proxy horizontally requires a shared store.
 */
export interface RateLimiter {
  hit(key: string): boolean;
}

export function createRateLimiter(options: {
  windowMs: number;
  max: number;
}): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    hit(key: string) {
      const now = Date.now();
      const bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + options.windowMs });
        if (buckets.size > 10_000) {
          for (const [k, b] of buckets) {
            if (now >= b.resetAt) buckets.delete(k);
          }
        }
        return true;
      }
      bucket.count += 1;
      return bucket.count <= options.max;
    },
  };
}

export function clientIp(req: { ip?: string | undefined; socket: { remoteAddress?: string | undefined } }): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}
