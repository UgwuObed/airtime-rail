// Fixed-window rate limiter, in memory. Enough for one server process; use a shared store if you run several.

export interface RateLimiter {
  /** Count one request for `key`. ok=false means over the limit; retryAfterSec says when the window resets. */
  hit(key: string): { ok: boolean; retryAfterSec: number };
}

export function createRateLimiter(o: { limit: number; windowMs: number; now?: () => number }): RateLimiter {
  const now = o.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(key) {
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= o.windowMs) {
        if (windows.size > 10_000) for (const [k, v] of windows) if (t - v.start >= o.windowMs) windows.delete(k);
        w = { start: t, count: 0 };
        windows.set(key, w);
      }
      w.count++;
      return { ok: w.count <= o.limit, retryAfterSec: Math.max(1, Math.ceil((w.start + o.windowMs - t) / 1000)) };
    },
  };
}
