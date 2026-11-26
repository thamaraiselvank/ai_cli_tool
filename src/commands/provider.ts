import { deleteKey, maskKey, resolveKey, saveKey } from '../config/credentials.js';
import { isUsable, providerStatuses, type ProviderStatus } from '../providers/discovery.js';
import { getProvider, isChatModel, listModels, validateKey } from '../providers/index.js';
import { chooseMainModel } from './model.js';
import type { CommandContext, SlashCommand } from './types.js';

function statusHint(p: ProviderStatus): string {
  if (p.local) return p.running ? '● running on this machine' : '○ not running (local, no key needed)';
  if (!p.keySource) return '✗ no key';
  return { env: '✓ key from environment', keychain: '✓ key in OS keychain', file: '✓ key in ~/.jarvis' }[p.keySource];
}

const WHERE = { keychain: 'your OS keychain', file: '~/.jarvis/credentials.json', env: 'the environment' } as const;

/** Ask for a key, prove it works by listing models, and only then save it. */
async function setKey(ctx: CommandContext, p: ProviderStatus): Promise<boolean> {
  const key = await ctx.ui.input({
    title: `Paste your ${p.name} API key`,
    mask: true,
    hint: p.signup ? `Get a free key at ${p.signup}` : undefined,
  });
  if (!key) return false;
  ctx.print(`Checking the ${p.name} key…`);
  try {
    await validateKey(p.name, key, ctx.router.settings.providers);
    const models = await listModels(p.name, false, ctx.router.settings.providers, key);
    const where = saveKey(p.name, key);
    ctx.print(`✓ ${p.name} key works (${models.filter(isChatModel).length} chat models). Saved to ${WHERE[where]}.`);
    if (p.keySource === 'env') ctx.print(`Note: ${p.apiKeyEnv} in your environment still takes priority over the saved key.`);
    return true;
  } catch (e) {
    ctx.print(`That key didn't work, so it was not saved: ${(e as Error).message.slice(0, 200)}`, 'error');
    return false;
  }
}

async function manage(ctx: CommandContext, p: ProviderStatus): Promise<boolean> {
  if (p.local) {
    const base = getProvider(p.name, ctx.router.settings.providers).baseURL;
    ctx.print(
      p.running
        ? `${p.name} is running at ${base}. Pick one of its models with /model.`
        : `${p.name} isn't reachable at ${base}.` +
            (p.name === 'ollama' ? ' Install it from ollama.com, then e.g. `ollama pull qwen2.5-coder:7b`.' : ' Start its local server first.'),
    );
    return Boolean(p.running);
  }
  if (!p.keySource) return setKey(ctx, p);

  const current = resolveKey(p.name, p.apiKeyEnv);
  const action = await ctx.ui.select({
    title: `${p.name} — key ${current ? maskKey(current.key) : ''} (${statusHint(p).replace(/^✓ /, '')})`,
    items: [
      { label: 'Test the key', value: 'test' },
      { label: 'Replace the key', value: 'replace' },
      { label: 'Remove the saved key', value: 'remove' },
    ],
  });
  if (action === 'replace') return setKey(ctx, p);
  if (action === 'remove') {
    deleteKey(p.name);
    ctx.print(
      `Removed the saved ${p.name} key.` + (p.keySource === 'env' ? ` (${p.apiKeyEnv} in your environment still provides one.)` : ''),
    );
  }
  if (action === 'test' && current) {
    try {
      await validateKey(p.name, current.key, ctx.router.settings.providers);
      const n = (await listModels(p.name, false, ctx.router.settings.providers)).filter(isChatModel).length;
      ctx.print(`✓ ${p.name} key works (${n} chat models).`);
    } catch (e) {
      ctx.print(`✗ ${p.name}: ${(e as Error).message.slice(0, 200)}`, 'error');
    }
  }
  return false;
}

export async function providerFlow(ctx: CommandContext, name?: string): Promise<boolean> {
  const statuses = await providerStatuses(ctx.router.settings);
  let chosen = name ? statuses.find((s) => s.name === name) : undefined;
  if (name && !chosen) {
    ctx.print(`Unknown provider "${name}". Known: ${statuses.map((s) => s.name).join(', ')}`, 'error');
    return false;
  }
  if (!chosen) {
    const pick = await ctx.ui.select({
      title: 'Providers — pick one to add or manage its key',
      items: statuses.map((s) => ({ label: s.name, value: s.name, hint: statusHint(s) })),
    });
    chosen = statuses.find((s) => s.name === pick);
    if (!chosen) return false;
  }
  const ready = await manage(ctx, chosen);
  // Just set up the first provider? Go straight to picking a model.
  if (ready && ctx.router.chain.length === 0) await chooseMainModel(ctx);
  return ready;
}

export const providerCommand: SlashCommand = {
  name: 'provider',
  aliases: ['login', 'providers'],
  args: '[name]',
  description: 'add, test or remove provider API keys',
  run: async (args, ctx) => {
    await providerFlow(ctx, args[0]);
  },
};

/** First run: nothing configured yet. Walk through provider → key → model. */
export async function onboarding(ctx: CommandContext) {
  ctx.print('Welcome to Jarvis! Let\'s connect a model provider. (Groq, OpenRouter, Gemini, Cerebras and Mistral have free tiers; Ollama runs locally.)');
  const statuses = await providerStatuses(ctx.router.settings);
  if (statuses.some(isUsable)) {
    // A key already exists (e.g. from an env var): just pick a model.
    if (await chooseMainModel(ctx)) return;
  } else if (await providerFlow(ctx)) {
    return;
  }
  ctx.print('Setup skipped. Run /provider and /model any time.');
}
