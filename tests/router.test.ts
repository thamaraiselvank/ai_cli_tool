import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import { ProviderConfigError } from '../src/providers/index.js';
import { backoffMs, parseDuration, retryAfterMs, TokenBucket } from '../src/providers/ratelimit.js';
import { classifyError, Router, type Attempt, type ModelResponse, type RouterEvent } from '../src/providers/router.js';

// ---- rate limiting ---------------------------------------------------------------------------

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then spaces requests out', () => {
    let t = 0;
    const b = new TokenBucket(60, () => t); // 60/min = 1 per second
    for (let i = 0; i < 60; i++) {
      expect(b.waitTime(1)).toBe(0);
      b.take(1);
    }
    expect(b.waitTime(1)).toBe(1000);
    t += 1000;
    expect(b.waitTime(1)).toBe(0);
  });
  it('caps oversized requests at capacity so they can still go through', () => {
    const b = new TokenBucket(100, () => 0);
    expect(b.waitTime(500)).toBe(0);
  });
  it('adjust() makes later requests wait when real usage beat the estimate', () => {
    let t = 0;
    const b = new TokenBucket(6000, () => t);
    b.take(1000);
    b.adjust(5000 + 3000); // used 3000 more than the 5000 remaining
    expect(b.waitTime(1000)).toBeGreaterThan(0);
  });
});

describe('retry timing', () => {
  it('reads retry-after headers in their different forms', () => {
    expect(retryAfterMs({ 'retry-after': '7' })).toBe(7000);
    expect(retryAfterMs({ 'Retry-After-Ms': '250' })).toBe(250);
    expect(retryAfterMs({ 'retry-after': new Date(10_000).toUTCString() }, 4_000)).toBe(6000);
    expect(retryAfterMs({ 'x-ratelimit-reset-tokens': '1m2.5s' })).toBe(62_500);
    expect(retryAfterMs({})).toBeUndefined();
  });
  it('parses durations', () => {
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('nope')).toBeUndefined();
  });
  it('backs off exponentially with a cap', () => {
    expect(backoffMs(0, 1000, 30_000, () => 1)).toBe(1000);
    expect(backoffMs(3, 1000, 30_000, () => 1)).toBe(8000);
    expect(backoffMs(10, 1000, 30_000, () => 1)).toBe(30_000);
  });
});

// ---- error classification ----------------------------------------------------------------------

function httpError(status: number, headers: Record<string, string> = {}) {
  return new APICallError({
    message: `HTTP ${status}`,
    url: 'https://x',
    requestBodyValues: {},
    statusCode: status,
    responseHeaders: headers,
    responseBody: `error ${status}`,
  });
}

describe('classifyError', () => {
  it('retries rate limits and overloads, with the server wait', () => {
    expect(classifyError(httpError(429, { 'retry-after': '2' }))).toMatchObject({ kind: 'retry', waitMs: 2000 });
    expect(classifyError(httpError(503)).kind).toBe('retry');
  });
  it('skips to another model for auth / missing model / config problems', () => {
    expect(classifyError(httpError(401)).kind).toBe('skip');
    expect(classifyError(httpError(404)).kind).toBe('skip');
    expect(classifyError(new ProviderConfigError('no key')).kind).toBe('skip');
    expect(classifyError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).kind).toBe('skip');
  });
  it('treats malformed requests as fatal', () => {
    expect(classifyError(httpError(400)).kind).toBe('fatal');
  });
});

// ---- router ------------------------------------------------------------------------------------

const ok = (model: string): ModelResponse => ({
  text: 'hi',
  toolCalls: [],
  model,
  usage: { input: 10, output: 2, cacheRead: 4 },
});

/** Fake model calls: each model gets a script of errors to throw before succeeding. */
function scripted(script: Record<string, unknown[]>): { attempt: Attempt; calls: string[] } {
  const calls: string[] = [];
  const attempt: Attempt = async function* (model) {
    calls.push(model);
    const next = script[model]?.shift();
    if (next) throw next;
    yield 'hi';
    return ok(model);
  };
  return { attempt, calls };
}

async function drain(gen: AsyncGenerator<RouterEvent, ModelResponse>) {
  const events: RouterEvent[] = [];
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return { events, result: r.value };
}

const req = { system: 's', messages: [], tools: {} };
const noSleep = async () => {};

describe('Router', () => {
  it('retries a 429 on the same model, then succeeds', async () => {
    const { attempt, calls } = scripted({ 'a/m': [httpError(429, { 'retry-after': '1' })] });
    const router = new Router({ chain: ['a/m', 'b/m'], settings: {}, attempt, sleep: noSleep });
    const { events, result } = await drain(router.call(req));
    expect(calls).toEqual(['a/m', 'a/m']);
    expect(result.model).toBe('a/m');
    expect(events.some((e) => e.type === 'notice' && /retrying in 1\.0s/.test(e.text))).toBe(true);
    expect(router.stats.get('a/m')).toMatchObject({ requests: 2, retries: 1, failures: 1, input: 10, cacheRead: 4 });
  });

  it('falls back immediately when the model does not exist', async () => {
    const { attempt, calls } = scripted({ 'a/m': [httpError(404)] });
    const router = new Router({ chain: ['a/m', 'b/m'], settings: {}, attempt, sleep: noSleep });
    const { result } = await drain(router.call(req));
    expect(calls).toEqual(['a/m', 'b/m']);
    expect(result.model).toBe('b/m');
    expect(router.lastModel).toBe('b/m');
  });

  it('falls back when the server asks for a wait longer than maxWaitSeconds, and remembers it', async () => {
    let t = 0;
    const { attempt, calls } = scripted({ 'a/m': [httpError(429, { 'retry-after': '3600' })] });
    const router = new Router({ chain: ['a/m', 'b/m'], settings: {}, attempt, sleep: noSleep, now: () => t });
    await drain(router.call(req));
    await drain(router.call(req)); // a/m is cooling down: skipped without a request
    expect(calls).toEqual(['a/m', 'b/m', 'b/m']);
  });

  it('gives up after maxRetries and reports the last error when every model fails', async () => {
    const e = () => httpError(503);
    const { attempt, calls } = scripted({ 'a/m': [e(), e(), e()], 'b/m': [httpError(401)] });
    const router = new Router({ chain: ['a/m', 'b/m'], settings: { retry: { maxRetries: 2 } }, attempt, sleep: noSleep });
    await expect(drain(router.call(req))).rejects.toThrow(/All models failed.*401/);
    expect(calls).toEqual(['a/m', 'a/m', 'a/m', 'b/m']);
  });

  it('does not retry a fatal error', async () => {
    const { attempt, calls } = scripted({ 'a/m': [httpError(400)] });
    const router = new Router({ chain: ['a/m', 'b/m'], settings: {}, attempt, sleep: noSleep });
    await expect(drain(router.call(req))).rejects.toThrow(/HTTP 400/);
    expect(calls).toEqual(['a/m']);
  });

  it('waits for the client-side RPM budget before calling', async () => {
    let t = 0;
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      t += ms;
    };
    const { attempt } = scripted({});
    const settings = { providers: { a: { rpm: 1 } } };
    const router = new Router({ chain: ['a/m'], settings, attempt, sleep, now: () => t });
    await drain(router.call(req));
    const { events } = await drain(router.call(req));
    expect(waits).toEqual([60_000]); // 1 per minute: the second call waits a full minute
    expect(events[0]).toMatchObject({ type: 'notice' });
  });
});
