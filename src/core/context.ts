import type { Settings } from '../config/settings.js';
import { effectiveLimit } from '../providers/modelInfo.js';
import type { Router } from '../providers/router.js';
import type { Message } from './messages.js';
import type { Session } from './session.js';
import { countTokens, messagesTokens } from './tokens.js';

/**
 * Context management: keeping the conversation under the model's limit.
 *
 * Two tools, cheapest first:
 *  1. Clear old tool outputs. Tool results (file contents, command output) are most of the bulk and
 *     go stale fast. Replacing old ones with a one-line placeholder keeps every user/assistant message
 *     intact, and the model can simply re-run the tool if it needs the data again.
 *  2. Compact: summarize the older part of the conversation with the model itself and keep only
 *     the summary + the most recent turns. Loses detail, so it's the second resort.
 *
 * Both rewrite earlier messages, which invalidates the provider's prompt cache (it matches exact
 * prefixes). That's why they trigger at thresholds and in batches — never a little every turn.
 */

export const CLEARED_PLACEHOLDER = '[Old tool output cleared to save context. Run the tool again if you need it.]';

export interface ContextConfig {
  /** Tokens available for one request (see modelInfo.effectiveLimit). */
  limit: number;
  clearAt: number;
  compactAt: number;
  keepToolResults: number;
}

export function contextConfig(settings: Settings, limit: number): ContextConfig {
  return {
    limit,
    clearAt: settings.context?.clearToolOutputAt ?? 0.5,
    compactAt: settings.context?.compactAt ?? 0.75,
    keepToolResults: settings.context?.keepToolResults ?? 4,
  };
}

/** Everything a request carries: system prompt + tool definitions + history. */
export function requestTokens(system: string, toolTokens: number, messages: Message[]): number {
  return countTokens(system) + toolTokens + messagesTokens(messages);
}

/** Long string values in tool-call args (e.g. Write's full file content) → short marker. */
function shrinkArgs(args: unknown): { args: unknown; changed: boolean } {
  if (!args || typeof args !== 'object') return { args, changed: false };
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 300) {
      out[k] = `[${v.length} chars cleared to save context]`;
      changed = true;
    } else out[k] = v;
  }
  return { args: out, changed };
}

/**
 * Replaces the content of all but the last `keep` tool results with a placeholder (skipping tiny
 * ones — clearing those saves nothing), and shrinks bulky arguments of the tool calls before that
 * point. Mutates in place (replacing message objects, never editing shared ones); returns how many
 * messages changed.
 */
export function clearOldToolResults(messages: Message[], keep: number): number {
  const toolIdx = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  const old = toolIdx.slice(0, Math.max(0, toolIdx.length - keep));
  if (old.length === 0) return 0;
  const boundary = toolIdx[toolIdx.length - keep] ?? messages.length; // first kept tool result
  let changed = 0;
  for (let i = 0; i < boundary; i++) {
    const m = messages[i]!;
    if (m.role === 'tool' && m.content !== CLEARED_PLACEHOLDER && m.content.length >= 300) {
      messages[i] = { ...m, content: CLEARED_PLACEHOLDER };
      changed++;
    } else if (m.role === 'assistant' && m.toolCalls) {
      const shrunk = m.toolCalls.map((c) => ({ c, s: shrinkArgs(c.args) }));
      if (shrunk.some((x) => x.s.changed)) {
        messages[i] = { ...m, toolCalls: shrunk.map(({ c, s }) => ({ ...c, args: s.args })) };
        changed++;
      }
    }
  }
  return changed;
}

/**
 * Where to cut for compaction: the index of the user message that starts the `keepTurns`-th most
 * recent turn. Everything before it gets summarized. Cutting at a user message guarantees we never
 * separate an assistant tool call from its tool result (providers reject that).
 * Undefined if there aren't enough turns to cut (e.g. one long agentic turn).
 */
export function findCut(messages: Message[], keepTurns = 2): number | undefined {
  const userIdx = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  if (userIdx.length <= keepTurns) return undefined;
  const cut = userIdx[userIdx.length - keepTurns]!;
  return cut > 0 ? cut : undefined;
}

const SUMMARY_SYSTEM = `You summarize a coding session so it can continue with only your summary as memory. Be specific and concise. Use these headings:
## Goal — what the user wants overall
## Done so far — changes made, with file paths
## Decisions & constraints — choices made and why; user preferences
## Current state — what was happening most recently
## Next steps — what remains
## Key details — exact names, paths, commands, errors or values that will be needed
Always keep every fact the user stated about themselves, their project or their preferences, even if it seems minor — the user expects these to be remembered.
Only include what's in the transcript. No preamble.`;

/**
 * A compact text transcript to summarize. Long pieces are trimmed (especially tool output) so the
 * summarization request itself fits the limit; if it's still too big, the oldest middle is dropped
 * (the first user message — usually the overall goal — is always kept).
 */
export function transcriptForSummary(messages: Message[], maxTokens: number): string {
  const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …[${s.length - n} chars trimmed]` : s);
  const parts = messages.map((m) => {
    if (m.role === 'user') return `USER: ${trim(m.content, 4000)}`;
    if (m.role === 'tool') return `TOOL RESULT (${m.toolName}${m.isError ? ', error' : ''}): ${trim(m.content, 400)}`;
    const calls = m.toolCalls?.map((c) => `${c.name}(${trim(JSON.stringify(c.args), 300)})`).join(', ');
    return `ASSISTANT: ${trim(m.content, 3000)}${calls ? `\n[called: ${calls}]` : ''}`;
  });
  // Count each part once, then drop from the oldest middle until it fits.
  const sizes = parts.map((p) => countTokens(p) + 2);
  let total = sizes.reduce((a, b) => a + b, 0);
  let dropped = 0;
  while (parts.length > 2 && total > maxTokens) {
    total -= sizes.splice(1, 1)[0]!;
    parts.splice(1, 1);
    dropped++;
  }
  if (dropped) parts.splice(1, 0, `[… ${dropped} earlier entries omitted …]`);
  return parts.join('\n\n');
}

export type ContextEvent =
  | { type: 'notice'; text: string }
  /** How full the context is after management; drives the status-bar gauge. */
  | { type: 'context'; used: number; limit: number };

export interface ManageOptions {
  router: Router;
  settings: Settings;
  system: string;
  /** Tokens of the tool definitions sent with each request. */
  toolTokens: number;
  session?: Session;
  abortSignal?: AbortSignal;
  /** Model whose window applies (a sub-agent's own); default: the router's current model. */
  model?: string;
}

const pct = (used: number, limit: number) => Math.round((100 * used) / limit);

/** Auto-compaction only runs when the part to summarize is at least this share of the limit. */
const MIN_COMPACT_SHARE = 0.2;

/** Matches provider errors that mean "your request is too big" (wording varies per provider). */
export function isContextOverflow(e: unknown): boolean {
  const msg = (e as Error)?.message ?? String(e);
  return /context.length|context window|maximum context|too large|reduce the length|HTTP 413|tokens per minute/i.test(msg);
}

/**
 * Runs before every model request. Under `clearAt` → nothing. Over it → clear old tool outputs.
 * Still over `compactAt` → summarize older turns. `force` does both regardless (used by /compact
 * and after a provider rejected a request as too large).
 * Mutates `messages` in place and records any rewrite in the session file.
 */
export async function* manageContext(
  messages: Message[],
  o: ManageOptions,
  force: { compact?: boolean; instructions?: string } = {},
): AsyncGenerator<ContextEvent, void> {
  const model = o.model ?? o.router.lastModel ?? o.router.chain[0];
  if (!model) return;
  const cfg = contextConfig(o.settings, await effectiveLimit(model, o.settings));
  const measure = () => requestTokens(o.system, o.toolTokens, messages);
  let used = measure();

  if (force.compact || used >= cfg.clearAt * cfg.limit) {
    const before = used;
    const n = clearOldToolResults(messages, cfg.keepToolResults);
    if (n) {
      used = measure();
      o.session?.rewrite(messages);
      yield { type: 'notice', text: `Context ${pct(before, cfg.limit)}% full: cleared ${n} old tool outputs (now ${pct(used, cfg.limit)}%).` };
    }
  }

  if (force.compact || used >= cfg.compactAt * cfg.limit) {
    const cut = findCut(messages);
    const olderTokens = cut === undefined ? 0 : messagesTokens(messages.slice(0, cut));
    // Summarizing only pays off when the older part is a real share of the context. If most of it
    // is the recent turns (which compaction keeps), a summary can't help — and would just run again
    // on every turn, burning a request and the prompt cache each time.
    const worthIt = olderTokens >= MIN_COMPACT_SHARE * cfg.limit;
    if (cut !== undefined && (worthIt || force.compact)) {
      const before = used;
      yield { type: 'notice', text: `Context ${pct(before, cfg.limit)}% full: summarizing older messages…` };
      const next = yield* compactHistory(messages, cut, o.router, cfg.limit, force.instructions, o.abortSignal, olderTokens);
      const after = requestTokens(o.system, o.toolTokens, next);
      if (after >= before) {
        yield { type: 'notice', text: 'Skipped compaction: the summary would not be smaller than what it replaces.' };
      } else {
        messages.splice(0, messages.length, ...next);
        used = after;
        o.session?.rewrite(messages);
        yield { type: 'notice', text: `Compacted: ${before.toLocaleString()} → ${used.toLocaleString()} tokens (${pct(used, cfg.limit)}%).` };
      }
    } else if (cut !== undefined) {
      // Not worth summarizing; at least make sure old tool output is gone.
      const n = clearOldToolResults(messages, 1);
      if (n) {
        used = measure();
        o.session?.rewrite(messages);
        yield { type: 'notice', text: `Context ${pct(used, cfg.limit)}% full: cleared ${n} more tool outputs.` };
      }
    } else {
      // One long turn with nothing safe to summarize: clear harder instead (keep only the last result).
      const n = clearOldToolResults(messages, 1);
      if (n) {
        used = measure();
        o.session?.rewrite(messages);
        yield { type: 'notice', text: `Context nearly full: cleared ${n} more tool outputs (now ${pct(used, cfg.limit)}%).` };
      } else if (force.compact) {
        yield { type: 'notice', text: 'Nothing to compact yet (the conversation is too short).' };
      }
    }
  }
  yield { type: 'context', used, limit: cfg.limit };
}

/**
 * Summarizes messages[0..cut) and returns the new history:
 *   [summary as a user message, short assistant ack, ...messages from cut]
 * The ack keeps user/assistant alternation tidy for providers that care about it.
 */
export async function* compactHistory(
  messages: Message[],
  cut: number,
  router: Router,
  limit: number,
  instructions?: string,
  abortSignal?: AbortSignal,
  olderTokens = messagesTokens(messages.slice(0, cut)),
): AsyncGenerator<ContextEvent, Message[]> {
  const older = messages.slice(0, cut);
  const transcript = transcriptForSummary(older, Math.floor(limit * 0.6));
  // A length budget: the summary must be clearly smaller than what it replaces (≈0.75 words/token).
  // Floor of 120 words: below that, summaries start dropping facts.
  const maxWords = Math.max(120, Math.min(800, Math.floor(olderTokens * 0.3 * 0.75)));
  const ask =
    `Summarize this coding session transcript in at most ${maxWords} words. Skip headings that have nothing to say.` +
    `${instructions ? `\nFocus especially on: ${instructions}` : ''}\n\n<transcript>\n${transcript}\n</transcript>`;

  const gen = router.call({ system: SUMMARY_SYSTEM, messages: [{ role: 'user', content: ask }], tools: {}, abortSignal });
  // Drain the stream: summary text is not shown in the chat, only notices are forwarded.
  let r = await gen.next();
  while (!r.done) {
    if (r.value.type === 'notice') yield r.value;
    r = await gen.next();
  }
  const summary = r.value.text.trim();
  if (!summary) throw new Error('Compaction failed: the model returned an empty summary.');

  return [
    {
      role: 'user',
      content: `[This conversation was compacted. Summary of the earlier part:]\n\n${summary}`,
    },
    { role: 'assistant', content: 'Understood. I have the summary of our earlier work and will continue from there.' },
    ...messages.slice(cut),
  ];
}
