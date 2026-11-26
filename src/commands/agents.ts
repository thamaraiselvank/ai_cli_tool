import { agentDirs, loadAgents } from '../agents/index.js';
import { loadSettings } from '../config/settings.js';
import { appendMemory, loadMemory, memoryPaths } from '../core/memory.js';
import { formatTodos, latestTodos } from '../tools/todo.js';
import type { SlashCommand } from './types.js';

export const agentsCommand: SlashCommand = {
  name: 'agents',
  description: 'list sub-agents the model can delegate to (Task tool)',
  run: (_args, ctx) => {
    const { agents, errors } = loadAgents(ctx.cwd);
    const defaultModel = loadSettings(ctx.cwd).agents?.model;
    const rows = agents.map((a) => {
      const tools = a.tools?.join(', ') ?? 'all tools';
      const model = a.model ?? defaultModel ?? 'main model';
      const src = a.source === 'built-in' ? 'built-in' : a.source;
      return `${a.name}  (${src})\n  ${a.description}\n  tools: ${tools} · model: ${model}`;
    });
    ctx.print(
      [
        ...rows,
        ...errors.map((e) => `Skipped: ${e}`),
        '',
        `Add your own as markdown in ${agentDirs(ctx.cwd).join(' or ')}:`,
        '  ---\n  name: reviewer\n  description: Reviews a diff for bugs\n  tools: Read, Grep, Glob, Bash\n  model: groq/<model>   (optional)\n  ---\n  <the agent\'s instructions>',
        'Set a default sub-agent model with "agents": { "model": "provider/model" } in settings.',
      ].join('\n'),
      errors.length ? 'error' : 'info',
    );
  },
};

export const memoryCommand: SlashCommand = {
  name: 'memory',
  args: '[add <note>]',
  description: 'show loaded JARVIS.md files, or add a note to ./JARVIS.md',
  run: (args, ctx) => {
    if (args[0] === 'add') {
      const note = args.slice(1).join(' ').trim();
      if (!note) return ctx.print('Give the note, e.g. /memory add Run tests with npm test', 'error');
      const file = appendMemory(ctx.cwd, note);
      return ctx.print(`Added to ${file}. It applies from your next message.`);
    }
    const loaded = loadMemory(ctx.cwd);
    const lines = loaded.length
      ? loaded.map((f) => `${f.path}  (${f.content.length.toLocaleString()} chars${f.truncated ? ', truncated' : ''})`)
      : ['No memory files yet.'];
    ctx.print(
      [
        ...lines,
        '',
        'Looked in (later = more specific):',
        ...memoryPaths(ctx.cwd).map((p) => `  ${p}`),
        'Edit them with any editor, or /memory add <note>. Changes apply from the next message.',
      ].join('\n'),
    );
  },
};

export const todosCommand: SlashCommand = {
  name: 'todos',
  description: "show the model's current checklist",
  run: (_args, ctx) => {
    const todos = latestTodos(ctx.conversation.messages());
    ctx.print(todos ? formatTodos(todos) : 'No checklist in this conversation yet.');
  },
};
