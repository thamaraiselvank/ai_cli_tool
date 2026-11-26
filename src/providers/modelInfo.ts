import type { Settings } from '../config/settings.js';
import { fetchModelEntries, parseModelRef } from './index.js';

/** Used when neither settings nor the provider tell us a model's context size. Deliberately modest. */
export const DEFAULT_CONTEXT_WINDOW = 32_768;

const cache = new Map<string, number>();

/**
 * The model's context window in tokens. Order: settings override → provider's /models metadata
 * (cached per process) → default. Never throws: a failed lookup just means using the default.
 */
export async function getContextWindow(ref: string, settings: Settings): Promise<number> {
  const override = settings.context?.windows?.[ref];
  if (override) return override;
  const hit = cache.get(ref);
  if (hit) return hit;

  let window = settings.context?.defaultWindow ?? DEFAULT_CONTEXT_WINDOW;
  try {
    const { provider, modelId } = parseModelRef(ref);
    const entries = await fetchModelEntries(provider, settings.providers, undefined, 5_000);
    const e = entries.find((m) => m.id === modelId);
    const reported = e?.context_window ?? e?.context_length ?? e?.max_context_length;
    if (reported && reported > 0) window = reported;
  } catch {
    /* offline, no key, unknown provider: keep the default */
  }
  cache.set(ref, window);
  return window;
}

/**
 * Tokens we can actually send in one request. Free tiers often cap tokens *per minute* below the
 * model's context window (a request bigger than the TPM budget is refused outright), so the
 * smaller of the two is the real ceiling.
 */
export async function effectiveLimit(ref: string, settings: Settings): Promise<number> {
  const window = await getContextWindow(ref, settings);
  const tpm = settings.providers?.[parseModelRef(ref).provider]?.tpm;
  return tpm ? Math.min(window, tpm) : window;
}

/** For tests. */
export function clearContextWindowCache() {
  cache.clear();
}
