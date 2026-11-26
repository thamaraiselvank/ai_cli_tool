import { updateSettings } from '../config/settings.js';
import { discoverModels } from '../providers/discovery.js';
import { parseModelRef } from '../providers/index.js';
import type { CommandContext, SlashCommand } from './types.js';

/** Models from all set-up providers, or a helpful message (and undefined) when there are none. */
async function fetchModels(ctx: CommandContext): Promise<string[] | undefined> {
  ctx.print('Fetching models from your providers…');
  const { models, errors } = await discoverModels(ctx.router.settings);
  for (const e of errors) ctx.print(`Skipped ${e}`, 'error');
  if (models.length === 0) {
    ctx.print('No models available. Add a provider key first with /provider.', 'error');
    return undefined;
  }
  return models;
}

function envOverrideNote(envVar: string): string {
  return process.env[envVar]
    ? `\nNote: ${envVar} is set in your environment and wins at startup; remove it to use this choice.`
    : '';
}

export async function chooseMainModel(ctx: CommandContext, preset?: string): Promise<boolean> {
  let choice = preset;
  if (!choice) {
    const models = await fetchModels(ctx);
    if (!models) return false;
    const [current, ...fallbacks] = ctx.router.chain;
    // Your current models first, so they aren't buried in a long list.
    const ordered = [...ctx.router.chain.filter((m) => models.includes(m)), ...models.filter((m) => !ctx.router.chain.includes(m))];
    choice = await ctx.ui.select({
      title: 'Main model',
      initial: current,
      items: ordered.map((m) => ({
        label: m,
        value: m,
        hint: m === current ? 'current' : fallbacks.includes(m) ? 'fallback' : undefined,
      })),
    });
    if (!choice) return false;
  }
  parseModelRef(choice); // validates the "provider/model" shape, throws a clear error otherwise
  // New main model first; the rest of the chain stays behind it as fallbacks.
  ctx.router.chain = [choice, ...ctx.router.chain.filter((m) => m !== choice)];
  const file = updateSettings('global', (s) => {
    s.model = choice;
    s.fallbacks = (s.fallbacks ?? []).filter((m) => m !== choice);
  });
  ctx.print(
    `Main model: ${choice}\nSaved to ${file}. Switching models starts a fresh prompt cache.${envOverrideNote('JARVIS_MODEL')}`,
  );
  return true;
}

export const modelCommand: SlashCommand = {
  name: 'model',
  args: '[provider/model]',
  description: 'pick the main model (from all your providers)',
  run: async (args, ctx) => {
    await chooseMainModel(ctx, args[0]);
  },
};

export const fallbackCommand: SlashCommand = {
  name: 'fallback',
  aliases: ['fallbacks'],
  args: '[clear]',
  description: 'pick backup models, in the order they should be tried',
  run: async (args, ctx) => {
    const [main, ...current] = ctx.router.chain;
    if (!main) return ctx.print('Pick a main model first with /model.', 'error');

    let chosen: string[] | undefined;
    if (args[0] === 'clear') chosen = [];
    else {
      const models = await fetchModels(ctx);
      if (!models) return;
      // Keep current fallbacks listed even if their provider didn't answer just now.
      const all = [...new Set([...current, ...models])].filter((m) => m !== main);
      chosen = await ctx.ui.multiSelect({
        title: `Fallbacks for ${main} — tick in priority order`,
        items: all.map((m) => ({ label: m, value: m, hint: parseModelRef(m).provider === parseModelRef(main).provider ? 'same provider' : undefined })),
        selected: current,
      });
      if (!chosen) return;
    }

    ctx.router.chain = [main, ...chosen];
    const file = updateSettings('global', (s) => {
      s.fallbacks = chosen;
    });
    ctx.print(
      (chosen.length ? `Chain: ${ctx.router.chain.join(' → ')}` : 'No fallbacks: only the main model will be used.') +
        `\nSaved to ${file}.${envOverrideNote('JARVIS_FALLBACKS')}`,
    );
  },
};
