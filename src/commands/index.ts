import { loadSettings, updateSettings } from '../config/settings.js';
import { parseRule } from '../permissions/index.js';
import { agentsCommand, memoryCommand, todosCommand } from './agents.js';
import { fallbackCommand, modelCommand } from './model.js';
import { providerCommand } from './provider.js';
import { compactCommand, contextCommand, resumeCommand } from './session.js';
import { runToolsCommand } from './tools.js';
import type { SlashCommand } from './types.js';

const helpCommand: SlashCommand = {
  name: 'help',
  description: 'list commands',
  run: (_args, ctx) => {
    const rows = COMMANDS.map((c) => {
      const name = `/${c.name}${c.args ? ' ' + c.args : ''}`;
      const aka = c.aliases?.length ? `  (also /${c.aliases.join(', /')})` : '';
      return `${name.padEnd(28)} ${c.description}${aka}`;
    });
    ctx.print([...rows, '', 'Esc stops a reply · Ctrl+C quits'].join('\n'));
  },
};

const usageCommand: SlashCommand = {
  name: 'usage',
  description: 'tokens, cache hits, retries per model',
  run: (_args, ctx) => ctx.print(ctx.router.formatUsage()),
};

const toolsCommand: SlashCommand = {
  name: 'tools',
  args: '[list|show|enable|disable|describe|reset]',
  description: 'manage tools (applies from the next message)',
  run: (args, ctx) => ctx.print(runToolsCommand(args, ctx.cwd)),
};

const permissionsCommand: SlashCommand = {
  name: 'permissions',
  args: '[allow|deny|remove <rule>]',
  description: 'show or edit always-allow / always-block rules',
  run: (args, ctx) => {
    const [sub, ...rest] = args;
    const rule = rest.join(' ');
    if (sub && ['allow', 'deny', 'remove'].includes(sub)) {
      if (!rule) return ctx.print('Give a rule, e.g. /permissions allow Bash(npm test:*)', 'error');
      parseRule(rule); // throws on bad syntax
      // Personal + per-project: stored in .jarvis/settings.local.json (gitignored).
      const file = updateSettings('local', (s) => {
        const p = { allow: s.permissions?.allow ?? [], deny: s.permissions?.deny ?? [] };
        p.allow = p.allow.filter((r) => r !== rule);
        p.deny = p.deny.filter((r) => r !== rule);
        if (sub === 'allow') p.allow.push(rule);
        if (sub === 'deny') p.deny.push(rule);
        s.permissions = p;
      }, ctx.cwd);
      return ctx.print(`${sub === 'remove' ? 'Removed' : sub === 'allow' ? 'Allowed' : 'Denied'} ${rule} in ${file}`);
    }
    const p = loadSettings(ctx.cwd).permissions ?? {};
    ctx.print(
      [
        `Allow: ${p.allow?.join(', ') || '(none)'}`,
        `Deny:  ${p.deny?.join(', ') || '(none)'}`,
        'Read-only tools are allowed inside the project by default; everything else asks.',
        'Rules: Tool, Tool(exact), Tool(prefix:*)  ·  e.g. /permissions allow Bash(git status)',
      ].join('\n'),
    );
  },
};

const clearCommand: SlashCommand = {
  name: 'clear',
  description: 'start a new conversation (the old one stays saved)',
  run: (_args, ctx) => {
    ctx.conversation.startNew();
    ctx.print('Started a new conversation. The previous one is saved; /resume brings it back.');
  },
};

const exitCommand: SlashCommand = {
  name: 'exit',
  aliases: ['quit'],
  description: 'quit Jarvis',
  run: (_args, ctx) => ctx.exit(),
};

/** Order here = order in /help and the autocomplete menu. */
export const COMMANDS: SlashCommand[] = [
  helpCommand,
  modelCommand,
  fallbackCommand,
  providerCommand,
  resumeCommand,
  compactCommand,
  contextCommand,
  usageCommand,
  toolsCommand,
  agentsCommand,
  memoryCommand,
  todosCommand,
  permissionsCommand,
  clearCommand,
  exitCommand,
];

export function findCommand(name: string): SlashCommand | undefined {
  const n = name.toLowerCase();
  return COMMANDS.find((c) => c.name === n || c.aliases?.includes(n));
}

/** Commands whose name or alias starts with `prefix` (for the "/" menu). */
export function matchCommands(prefix: string): SlashCommand[] {
  const p = prefix.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(p) || c.aliases?.some((a) => a.startsWith(p)));
}
