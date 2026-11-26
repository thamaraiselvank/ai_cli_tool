import { describe, expect, it } from 'vitest';
import { parseModelRef } from '../src/providers/index.js';

describe('parseModelRef', () => {
  it('splits provider from model id', () => {
    expect(parseModelRef('groq/llama-3.3-70b-versatile')).toEqual({
      provider: 'groq',
      modelId: 'llama-3.3-70b-versatile',
    });
  });

  it('keeps slashes inside OpenRouter model ids', () => {
    expect(parseModelRef('openrouter/qwen/qwen3-coder:free')).toEqual({
      provider: 'openrouter',
      modelId: 'qwen/qwen3-coder:free',
    });
  });

  it('rejects refs without a provider', () => {
    expect(() => parseModelRef('llama3')).toThrow();
    expect(() => parseModelRef('/x')).toThrow();
    expect(() => parseModelRef('groq/')).toThrow();
  });
});
