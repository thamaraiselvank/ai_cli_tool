import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';
import type { Message } from './messages.js';

/**
 * Token counting with OpenAI's o200k tokenizer. Every model family tokenizes differently (Llama,
 * Qwen, Gemini…), so for non-OpenAI models this is an approximation — typically within ~10-20%.
 * That's fine for its job here: deciding *when* to clear or compact, with margin built into the
 * thresholds. The provider's own usage numbers remain the truth for what was actually billed.
 */
let encoder: Tiktoken | undefined;

export function countTokens(text: string): number {
  if (!text) return 0;
  encoder ??= new Tiktoken(o200k);
  // [] for disallowed specials: treat "<|endoftext|>" in a file as plain text instead of throwing.
  return encoder.encode(text, [], []).length;
}

/** Per-message framing the API adds (role markers etc.); a few tokens each. */
const MESSAGE_OVERHEAD = 4;

// Messages never change once written (except when we deliberately clear one, which replaces
// its content — see context.ts), so counts are cached by object identity.
const cache = new WeakMap<Message, { content: string; tokens: number }>();

export function messageTokens(m: Message): number {
  const hit = cache.get(m);
  if (hit && hit.content === m.content) return hit.tokens;
  let tokens = MESSAGE_OVERHEAD + countTokens(m.content);
  if (m.role === 'assistant' && m.toolCalls) {
    for (const c of m.toolCalls) tokens += countTokens(c.name) + countTokens(JSON.stringify(c.args ?? {})) + MESSAGE_OVERHEAD;
  }
  cache.set(m, { content: m.content, tokens });
  return tokens;
}

export function messagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}
