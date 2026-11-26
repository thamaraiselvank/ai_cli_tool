import { loadSettings } from '../config/settings.js';
import { CLEARED_PLACEHOLDER, contextConfig, manageContext } from '../core/context.js';
import { Session } from '../core/session.js';
import { countTokens, messagesTokens } from '../core/tokens.js';
import { effectiveLimit } from '../providers/modelInfo.js';
import { activeTools, estimateToolTokens } from '../tools/registry.js';
import type { CommandContext, SlashCommand } from './types.js';

/** "3 min ago", "yesterday 14:05", "Nov 22" */
export function relativeTime(d: Date, now = new Date()): string {
  const mins = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const time = d.toTimeString().slice(0, 5);
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Picker of this project's saved conversations; loads the chosen one. */
export async function resumePicker(ctx: CommandContext): Promise<boolean> {
  const current = ctx.conversation.session().id;
  const sessions = Session.list(ctx.cwd).filter((s) => s.id !== current);
  if (sessions.length === 0) {
    ctx.print('No saved conversations in this folder yet.');
    return false;
  }
  const file = await ctx.ui.select({
    title: 'Resume a conversation',
    items: sessions.map((s) => ({
      label: `${relativeTime(s.updated).padEnd(16)} ${s.title}`,
      value: s.file,
      hint: `${s.messages} msgs`,
    })),
  });
  if (!file) return false;
  const { session, messages } = Session.load(file, ctx.cwd);
  ctx.conversation.load(messages, session);
  return true;
}

export const resumeCommand: SlashCommand = {
  name: 'resume',
  args: '[id]',
  description: 'continue a saved conversation from this folder',
  run: async (args, ctx) => {
    if (args[0]) {
      const found = Session.find(ctx.cwd, args[0]);
      if (!found) return ctx.print(`No conversation with id "${args[0]}" in this folder.`, 'error');
      const { session, messages } = Session.load(found.file, ctx.cwd);
      return ctx.conversation.load(messages, session);
    }
    await resumePicker(ctx);
  },
};

export const compactCommand: SlashCommand = {
  name: 'compact',
  args: '[what to focus on]',
  description: 'summarize older messages to free up context',
  run: async (args, ctx) => {
    const settings = loadSettings(ctx.cwd);
    const messages = ctx.conversation.messages();
    const gen = manageContext(
      messages,
      {
        router: ctx.router,
        settings,
        system: ctx.conversation.system,
        toolTokens: activeTools(settings, ctx.cwd, ctx.mcp?.tools()).reduce((n, t) => n + estimateToolTokens(t), 0),
        session: ctx.conversation.session(),
      },
      { compact: true, instructions: args.join(' ') || undefined },
    );
    for await (const ev of gen) {
      if (ev.type === 'notice') ctx.print(ev.text);
      else ctx.setContextUsage?.(ev.used, ev.limit);
    }
  },
};

export const contextCommand: SlashCommand = {
  name: 'context',
  description: 'show how full the context is, and what fills it',
  run: async (_args, ctx) => {
    const settings = loadSettings(ctx.cwd);
    const model = ctx.router.lastModel ?? ctx.router.chain[0];
    if (!model) return ctx.print('No model selected yet. Use /model.', 'error');
    const cfg = contextConfig(settings, await effectiveLimit(model, settings));
    const messages = ctx.conversation.messages();
    const system = countTokens(ctx.conversation.system);
    const tools = activeTools(settings, ctx.cwd, ctx.mcp?.tools()).reduce((n, t) => n + estimateToolTokens(t), 0);
    const toolOut = messagesTokens(messages.filter((m) => m.role === 'tool' && m.content !== CLEARED_PLACEHOLDER));
    const chat = messagesTokens(messages) - toolOut;
    const total = system + tools + toolOut + chat;
    const row = (label: string, n: number) =>
      `${label.padEnd(20)} ${n.toLocaleString().padStart(8)}  ${((100 * n) / cfg.limit).toFixed(1).padStart(5)}%`;
    ctx.print(
      [
        `${model} — limit ${cfg.limit.toLocaleString()} tokens`,
        row('System prompt', system),
        row('Tool definitions', tools),
        row('Conversation', chat),
        row('Tool outputs', toolOut),
        row('Total', total),
        `Old tool outputs are cleared at ${cfg.clearAt * 100}%, older messages summarized at ${cfg.compactAt * 100}%.`,
        `Saved as ${ctx.conversation.session().file}`,
      ].join('\n'),
    );
    ctx.setContextUsage?.(total, cfg.limit);
  },
};
