/**
 * Token bucket: holds up to `capacity` units and refills continuously at capacity-per-minute.
 * Why a bucket instead of "N per fixed minute window": it smooths bursts. With RPM 30 you can fire
 * a few requests back to back, then it naturally spaces the rest ~2s apart instead of letting you
 * burn all 30 in one second and then stall (which is exactly how free tiers get 429s).
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly ratePerMs: number;

  constructor(
    readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
    this.ratePerMs = capacity / 60_000;
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.ratePerMs);
    this.last = t;
  }

  /** Milliseconds until `n` units are available (0 = now). Requests above capacity wait for a full bucket. */
  waitTime(n: number): number {
    this.refill();
    const need = Math.min(n, this.capacity);
    return this.tokens >= need ? 0 : Math.ceil((need - this.tokens) / this.ratePerMs);
  }

  take(n: number) {
    this.refill();
    this.tokens -= Math.min(n, this.capacity);
  }

  /**
   * Correct an earlier estimate once the real usage is known. Can push the bucket negative,
   * which simply makes the next request wait longer: we spent tokens we didn't budget for.
   */
  adjust(delta: number) {
    this.refill();
    this.tokens = Math.min(this.capacity, this.tokens - delta);
  }
}

/** One provider's limits: requests/minute and tokens/minute. Either can be absent (= unlimited). */
export class ProviderLimiter {
  readonly rpm?: TokenBucket;
  readonly tpm?: TokenBucket;

  constructor(limits: { rpm?: number; tpm?: number }, now: () => number = Date.now) {
    if (limits.rpm) this.rpm = new TokenBucket(limits.rpm, now);
    if (limits.tpm) this.tpm = new TokenBucket(limits.tpm, now);
  }

  waitTime(tokens: number): number {
    return Math.max(this.rpm?.waitTime(1) ?? 0, this.tpm?.waitTime(tokens) ?? 0);
  }

  take(tokens: number) {
    this.rpm?.take(1);
    this.tpm?.take(tokens);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Server-requested wait, from `retry-after-ms`, `retry-after` (seconds or an HTTP date), or
 * Groq/OpenAI-style `x-ratelimit-reset-*` values like "2.5s" / "1m30s". Undefined if none present.
 */
export function retryAfterMs(headers: Record<string, string> | undefined, now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const ms = Number(h['retry-after-ms']);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const ra = h['retry-after'];
  if (ra !== undefined) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const reset = h['x-ratelimit-reset-requests'] ?? h['x-ratelimit-reset-tokens'];
  if (reset) return parseDuration(reset);
  return undefined;
}

/** "1m30.5s" | "250ms" | "2s" → milliseconds. */
export function parseDuration(s: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (const [, n, unit] of s.matchAll(re)) {
    matched = true;
    total += Number(n) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit as 'ms' | 's' | 'm' | 'h'];
  }
  return matched ? total : undefined;
}

/** Exponential backoff with "full jitter": random in [0, base·2^attempt], capped. Jitter stops
 * many clients (or parallel sub-agents) from retrying in lock-step and colliding again. */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 30_000, random = Math.random): number {
  return Math.round(random() * Math.min(capMs, baseMs * 2 ** attempt));
}
