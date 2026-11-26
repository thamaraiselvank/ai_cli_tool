import { APICallError, isStepCount, streamText, type ToolSet } from 'ai';
import type { Settings } from '../config/settings.js';
import { toModelMessages, type Message, type ToolCall } from '../core/messages.js';
import { parseModelRef, ProviderConfigError, resolveModel } from './index.js';
import { backoffMs, ProviderLimiter, retryAfterMs, sleep } from './ratelimit.js';

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSet;
  abortSignal?: AbortSignal;
  /**
   * Model chain for this request only (sub-agents on a cheaper model). Same Router, so rate limits,
   * cooldowns and usage stats stay shared with the main conversation.
   */
  models?: string[];
}

export interface Usage {
  input: number;
  output: number;
  /** Input tokens served from the provider's prompt cache (0 if unsupported/unreported). */
  cacheRead: number;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  model: string;
  usage: Usage;
}

export type RouterEvent = { type: 'text'; text: string } | { type: 'notice'; text: string };

/** One raw model call: yields text chunks, returns the final response. Swappable for tests. */
export type Attempt = (model: string, req: ModelRequest) => AsyncGenerator<string, ModelResponse>;

export interface ModelStats extends Usage {
  requests: number;
  retries: number;
  failures: number;
}

// ---------------------------------------------------------------------------------------------
// Error classification: the heart of "retry vs fall back vs give up".
// ---------------------------------------------------------------------------------------------

export type ErrorClass =
  /** Temporary (rate limit, overload, network blip): wait and try the same model again. */
  | { kind: 'retry'; waitMs?: number; reason: string }
  /** This model can't serve us (bad key, unknown model, not running): try the next model. */
  | { kind: 'skip'; reason: string }
  /** Our request is wrong; another model would fail the same way. Surface it. */
  | { kind: 'fatal'; reason: string };

const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const SKIP_STATUSES = new Set([401, 402, 403, 404, 413]);

export function classifyError(e: unknown): ErrorClass {
  if (e instanceof ProviderConfigError) return { kind: 'skip', reason: e.message };
  if (APICallError.isInstance(e)) {
    const status = e.statusCode;
    const body = (e.responseBody ?? e.message).slice(0, 200).replace(/\s+/g, ' ');
    const reason = status ? `HTTP ${status}: ${body}` : e.message;
    if (status && RETRY_STATUSES.has(status)) return { kind: 'retry', waitMs: retryAfterMs(e.responseHeaders), reason };
    if (status && SKIP_STATUSES.has(status)) return { kind: 'skip', reason };
    if (!status) return networkClass(e.cause ?? e, reason);
    return { kind: 'fatal', reason };
  }
  return networkClass(e, (e as Error)?.message ?? String(e));
}

function networkClass(e: unknown, reason: string): ErrorClass {
  const text = `${(e as Error)?.message ?? ''} ${(e as { code?: string })?.code ?? ''} ${String((e as Error)?.cause ?? '')}`;
  // Refused/unknown host: e.g. Ollama isn't running. Waiting won't fix that quickly.
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(text)) return { kind: 'skip', reason };
  if (/fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(text)) return { kind: 'retry', reason };
  return { kind: 'fatal', reason };
}

// ---------------------------------------------------------------------------------------------

/** Rough input size in tokens (chars/4) plus a reserve for tool definitions and the reply. */
export function estimateTokens(req: Pick<ModelRequest, 'system' | 'messages'>): number {
  const chars = req.system.length + JSON.stringify(req.messages).length;
  return Math.ceil(chars / 4) + 1500;
}

export interface RouterOptions {
  /** [primary, ...fallbacks] */
  chain: string[];
  settings: Settings;
  attempt?: Attempt;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Picks a model for each request and gets a response out of it, handling everything that goes wrong
 * with free tiers: client-side rate limits (so we rarely hit 429s), server 429s/5xx (retry with the
 * server's Retry-After or exponential backoff), and dead or exhausted models (fall back down the chain).
 *
 * Trade-off worth knowing: switching models mid-conversation throws away the provider's prompt cache
 * (caches are per model), so fallback costs a full-price request. That's why we retry short waits on
 * the same model first and only fall back when the wait is long or the model is unusable.
 */
export class Router {
  chain: string[];
  /** Model that answered the last request (may differ from chain[0] after a fallback). */
  lastModel?: string;
  readonly stats = new Map<string, ModelStats>();

  private readonly limiters = new Map<string, ProviderLimiter>();
  /** model → time until which we skip it (it told us to wait longer than we're willing to). */
  private readonly cooldownUntil = new Map<string, number>();
  private readonly attempt: Attempt;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly opts: RouterOptions) {
    this.chain = [...new Set(opts.chain)];
    this.attempt = opts.attempt ?? sdkAttempt(opts.settings);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? sleep;
  }

  get settings(): Settings {
    return this.opts.settings;
  }

  private limiter(model: string): ProviderLimiter {
    const { provider } = parseModelRef(model);
    let l = this.limiters.get(provider);
    if (!l) {
      // Limits are per provider (that's how free tiers count), shared by all its models.
      l = new ProviderLimiter(this.opts.settings.providers?.[provider] ?? {}, this.now);
      this.limiters.set(provider, l);
    }
    return l;
  }

  private stat(model: string): ModelStats {
    let s = this.stats.get(model);
    if (!s) {
      s = { requests: 0, retries: 0, failures: 0, input: 0, output: 0, cacheRead: 0 };
      this.stats.set(model, s);
    }
    return s;
  }

  async *call(req: ModelRequest): AsyncGenerator<RouterEvent, ModelResponse> {
    const maxRetries = this.opts.settings.retry?.maxRetries ?? 3;
    const maxWaitMs = (this.opts.settings.retry?.maxWaitSeconds ?? 30) * 1000;
    const chain = req.models?.length ? [...new Set(req.models)] : this.chain;
    if (chain.length === 0) {
      throw new ProviderConfigError('No model selected yet. Use /model (or /provider to add a key first).');
    }

    const ready = chain.filter((m) => (this.cooldownUntil.get(m) ?? 0) <= this.now());
    // Everything cooling down? Try them all anyway rather than failing without a single request.
    const candidates = ready.length ? ready : chain;
    let lastReason = 'no models configured';

    for (const [mi, model] of candidates.entries()) {
      const stats = this.stat(model);
      let failure: ErrorClass | undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // 1. Client-side rate limit: wait for budget, unless the wait is unreasonable.
        let limiter: ProviderLimiter;
        try {
          limiter = this.limiter(model);
        } catch (e) {
          failure = classifyError(e);
          break;
        }
        const estimate = estimateTokens(req);
        const wait = limiter.waitTime(estimate);
        // A long local wait is worth skipping only if there's another model to use instead.
        // Otherwise just wait: our own limiter's wait is exact, unlike a server's daily-quota 429.
        const hasNext = mi < candidates.length - 1;
        if (wait > maxWaitMs && hasNext) {
          failure = { kind: 'skip', reason: `local rate limit needs ${Math.ceil(wait / 1000)}s` };
          break;
        }
        if (wait > 0) {
          yield { type: 'notice', text: `Waiting ${Math.ceil(wait / 1000)}s for ${parseModelRef(model).provider} rate limit…` };
          await this.sleep(wait, req.abortSignal);
        }
        limiter.take(estimate);

        // 2. The actual call.
        let streamed = false;
        stats.requests++;
        try {
          const gen = this.attempt(model, req);
          let r = await gen.next();
          while (!r.done) {
            streamed = true;
            yield { type: 'text', text: r.value };
            r = await gen.next();
          }
          const res = r.value;
          limiter.tpm?.adjust(res.usage.input + res.usage.output - estimate);
          stats.input += res.usage.input;
          stats.output += res.usage.output;
          stats.cacheRead += res.usage.cacheRead;
          // A sub-agent's model must not change what the status bar and main context limit use.
          if (!req.models) this.lastModel = model;
          return res;
        } catch (e) {
          if (req.abortSignal?.aborted) throw e;
          stats.failures++;
          // Text already reached the screen: a retry would print it twice. Surface the error instead.
          if (streamed) throw e;
          failure = classifyError(e);
          if (failure.kind === 'fatal') throw e;
          if (failure.kind === 'skip' || attempt === maxRetries) break;

          const delay = failure.waitMs ?? backoffMs(attempt);
          if (delay > maxWaitMs) {
            this.cooldownUntil.set(model, this.now() + delay);
            break;
          }
          stats.retries++;
          yield { type: 'notice', text: `${model}: ${short(failure.reason)} — retrying in ${(delay / 1000).toFixed(1)}s (${attempt + 1}/${maxRetries})` };
          await this.sleep(delay, req.abortSignal);
        }
      }

      lastReason = failure?.reason ?? 'unknown error';
      if (failure?.kind === 'skip') this.cooldownUntil.set(model, this.now() + 10 * 60_000);
      const next = candidates[mi + 1];
      if (next) yield { type: 'notice', text: `${model} unavailable (${short(lastReason)}). Falling back to ${next}.` };
    }
    throw new Error(`All models failed. Last error: ${lastReason}`);
  }

  formatUsage(): string {
    if (this.stats.size === 0) return 'No requests yet.';
    const rows = [...this.stats].map(([m, s]) => {
      const cached = s.input ? ` (${Math.round((100 * s.cacheRead) / s.input)}% cached)` : '';
      return `${m}\n  ${s.requests} attempts, ${s.retries} retries, ${s.failures} failures · in ${s.input}${cached} · out ${s.output}`;
    });
    return [`Chain: ${this.chain.join(' → ')}`, ...rows].join('\n');
  }

  totals(): Usage {
    let input = 0, output = 0, cacheRead = 0;
    for (const s of this.stats.values()) {
      input += s.input;
      output += s.output;
      cacheRead += s.cacheRead;
    }
    return { input, output, cacheRead };
  }
}

function short(s: string) {
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

/** The real Attempt: one streamText call through the AI SDK. */
export function sdkAttempt(settings: Settings): Attempt {
  return async function* (model, req) {
    let streamError: unknown;
    const result = streamText({
      model: resolveModel(model, settings.providers),
      system: req.system,
      messages: toModelMessages(req.messages),
      tools: req.tools,
      // One model call per streamText: our loop runs the tools, then calls again.
      stopWhen: isStepCount(1),
      // The Router owns retries (it knows about fallbacks and rate limits); SDK retries would stack.
      maxRetries: 0,
      abortSignal: req.abortSignal,
      onError: ({ error }) => {
        streamError = error;
      },
    });
    let text = '';
    for await (const chunk of result.textStream) {
      text += chunk;
      yield chunk;
    }
    if (streamError) throw streamError;
    const toolCalls = (await result.toolCalls).map((c) => ({ id: c.toolCallId, name: c.toolName, args: c.input }));
    const u = await result.usage;
    return {
      text,
      toolCalls,
      model,
      usage: { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.inputTokenDetails?.cacheReadTokens ?? 0 },
    };
  };
}
