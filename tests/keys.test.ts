import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyBelongsElsewhere, validateKey } from '../src/providers/index.js';

afterEach(() => vi.unstubAllGlobals());

/** Records the URL each fetch hits and answers with the given status. */
function stubFetch(status: number) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url);
    return new Response(status === 200 ? '{}' : '{"error":"invalid key"}', { status });
  });
  return urls;
}

describe('key validation', () => {
  it('spots a key pasted into the wrong provider, without any request', async () => {
    const urls = stubFetch(200);
    expect(keyBelongsElsewhere('openrouter', 'gsk_abc')).toBe('groq');
    await expect(validateKey('openrouter', 'gsk_abc123')).rejects.toThrow(/looks like a groq key/);
    expect(urls).toEqual([]);
  });

  it('checks OpenRouter keys on /key, because its /models is public', async () => {
    const urls = stubFetch(200);
    await validateKey('openrouter', 'sk-or-v1-good');
    expect(urls).toEqual(['https://openrouter.ai/api/v1/key']);
  });

  it('uses /models for providers where it requires auth', async () => {
    const urls = stubFetch(200);
    await validateKey('groq', 'gsk_good');
    expect(urls).toEqual(['https://api.groq.com/openai/v1/models']);
  });

  it('rejects keys the provider refuses', async () => {
    stubFetch(401);
    await expect(validateKey('groq', 'gsk_bad')).rejects.toThrow(/groq rejected the key/);
  });
});
