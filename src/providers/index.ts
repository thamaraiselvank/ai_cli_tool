import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { resolveKey } from '../config/credentials.js';

/**
 * Providers' /models lists include speech, safety and embedding models that can't chat. Hiding them
 * keeps the /model picker useful. A heuristic on the id; anything missed can still be typed by hand.
 */
const NON_CHAT = /whisper|tts|orpheus|guard|safeguard|embed|moderation|transcribe|audio|image|dall-e|rerank|playai/i;
export const isChatModel = (id: string) => !NON_CHAT.test(id);

/**
 * Why one adapter for (almost) everything: OpenRouter, Groq, Cerebras, Mistral, Gemini and a local
 * Ollama server all expose the same OpenAI-style `/chat/completions` endpoint. So a provider here is
 * just "base URL + which env var holds the key". Adding a new free provider is one table entry.
 */
export interface ProviderInfo {
  baseURL: string;
  /** Env var holding the API key. Undefined = no key needed (local servers). */
  apiKeyEnv?: string;
  /** Where to get a key, shown in error messages. */
  signup?: string;
  /**
   * Path that requires a valid key, used to check keys. Defaults to /models, but some providers
   * (OpenRouter) serve /models publicly — any key "works" there, so it proves nothing.
   */
  keyCheckPath?: string;
  /** Known key prefix, used to catch a key pasted into the wrong provider. */
  keyPrefix?: string;
}

export const PROVIDERS: Record<string, ProviderInfo> = {
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    signup: 'https://openrouter.ai/keys',
    keyCheckPath: '/key', // its /models is public: any key gets 200 there
    keyPrefix: 'sk-or-',
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    signup: 'https://console.groq.com/keys',
    keyPrefix: 'gsk_',
  },
  cerebras: {
    baseURL: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    signup: 'https://cloud.cerebras.ai',
    keyPrefix: 'csk-',
  },
  mistral: {
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    signup: 'https://console.mistral.ai/api-keys',
  },
  gemini: {
    // Gemini's OpenAI-compatible endpoint; a native @ai-sdk/google adapter can replace this later.
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    signup: 'https://aistudio.google.com/apikey',
    keyPrefix: 'AIza',
  },
  ollama: { baseURL: 'http://localhost:11434/v1' },
  lmstudio: { baseURL: 'http://localhost:1234/v1' },
};

/** A setup problem (unknown provider, missing key): retrying won't help, but another model might. */
export class ProviderConfigError extends Error {}

/** "This looks like a groq key" if `key` carries another provider's known prefix. */
export function keyBelongsElsewhere(provider: string, key: string): string | undefined {
  for (const [name, info] of Object.entries(PROVIDERS)) {
    if (name !== provider && info.keyPrefix && key.startsWith(info.keyPrefix)) return name;
  }
  return undefined;
}

/**
 * Proves a key works by calling an endpoint that requires authentication. Two layers:
 *  1. offline prefix check — catches the common "pasted the Groq key into OpenRouter" mistake
 *     instantly and with a clear message;
 *  2. a real authenticated request — the only actual proof. Note it must be an endpoint that
 *     *rejects* bad keys; a public endpoint would happily "validate" anything.
 */
export async function validateKey(
  provider: string,
  key: string,
  overrides: Record<string, ProviderSettings> = {},
): Promise<void> {
  const info = getProvider(provider, overrides);
  const other = keyBelongsElsewhere(provider, key);
  if (other) throw new ProviderConfigError(`This looks like a ${other} key (it starts with "${PROVIDERS[other]!.keyPrefix}"), not a key for ${provider}.`);
  const res = await fetch(`${info.baseURL}${info.keyCheckPath ?? '/models'}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return;
  const body = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
  const why = res.status === 401 || res.status === 403 || res.status === 400 ? `${provider} rejected the key` : `${provider} answered HTTP ${res.status}`;
  throw new ProviderConfigError(`${why}: ${body}`);
}

export interface ModelRef {
  provider: string;
  modelId: string;
}

/**
 * "provider/model" → { provider, modelId }. Split on the FIRST slash only, because OpenRouter model
 * ids contain slashes themselves: "openrouter/qwen/qwen3-coder:free".
 */
export function parseModelRef(ref: string): ModelRef {
  const i = ref.indexOf('/');
  if (i <= 0 || i === ref.length - 1) {
    throw new ProviderConfigError(`Model must look like "provider/model-id", got "${ref}".`);
  }
  return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/** Per-provider settings: override a built-in (key env var, limits) or define a new provider (baseURL). */
export interface ProviderSettings {
  baseURL?: string;
  apiKeyEnv?: string;
  /** Requests per minute. Unset = no client-side limit (we still honor the server's 429s). */
  rpm?: number;
  /** Tokens per minute (input + output). */
  tpm?: number;
}

export function getProvider(name: string, overrides: Record<string, ProviderSettings> = {}): ProviderInfo & ProviderSettings {
  const info = { ...PROVIDERS[name], ...overrides[name] };
  if (!info.baseURL) {
    throw new ProviderConfigError(
      `Unknown provider "${name}". Known: ${Object.keys(PROVIDERS).join(', ')}. ` +
        `To add your own, set providers.${name}.baseURL in settings.`,
    );
  }
  return info as ProviderInfo & ProviderSettings;
}

/** Providers that run on this machine and need no key. */
export const isLocalProvider = (info: ProviderInfo) => !info.apiKeyEnv;

function apiKeyFor(name: string, info: ProviderInfo): string | undefined {
  if (isLocalProvider(info)) return undefined;
  const found = resolveKey(name, info.apiKeyEnv);
  if (!found) {
    throw new ProviderConfigError(
      `No API key for "${name}". Add one with /provider inside Jarvis (or set ${info.apiKeyEnv}).` +
        (info.signup ? ` Get a free key at ${info.signup}` : ''),
    );
  }
  return found.key;
}

export function resolveModel(ref: string, overrides: Record<string, ProviderSettings> = {}): LanguageModel {
  const { provider, modelId } = parseModelRef(ref);
  const info = getProvider(provider, overrides);
  const sdk = createOpenAICompatible({
    name: provider,
    baseURL: info.baseURL,
    apiKey: apiKeyFor(provider, info),
    // Ask for token usage in the stream so we can track TPM budgets and show usage/cache hits.
    includeUsage: true,
  });
  return sdk(modelId);
}

/** One entry of a provider's /models list; field names vary by provider. */
export interface ModelEntry {
  id: string;
  pricing?: { prompt?: string; completion?: string };
  context_window?: number; // Groq
  context_length?: number; // OpenRouter, Groq
  max_context_length?: number; // Mistral
}

export async function fetchModelEntries(
  name: string,
  overrides: Record<string, ProviderSettings> = {},
  explicitKey?: string,
  timeoutMs = 10_000,
): Promise<ModelEntry[]> {
  const info = getProvider(name, overrides);
  const key = explicitKey ?? apiKeyFor(name, info);
  const res = await fetch(`${info.baseURL}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${name} /models failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { data?: ModelEntry[] }).data ?? [];
}

/** Lists model ids from a provider's /models endpoint. `freeOnly` uses OpenRouter's pricing data. */
export async function listModels(
  name: string,
  freeOnly = false,
  overrides: Record<string, ProviderSettings> = {},
  /** Test a key before saving it, instead of using the stored one. */
  explicitKey?: string,
  timeoutMs = 10_000,
): Promise<string[]> {
  let models = await fetchModelEntries(name, overrides, explicitKey, timeoutMs);
  if (freeOnly) {
    models = models.filter(
      (m) => m.id.endsWith(':free') || (m.pricing?.prompt === '0' && m.pricing?.completion === '0'),
    );
  }
  return models.map((m) => m.id).sort();
}
