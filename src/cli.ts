#!/usr/bin/env node
import { Command } from 'commander';
import React from 'react';
import { render } from 'ink';
import { runToolsCommand, TOOLS_HELP } from './commands/tools.js';
import { loadSettings, type Settings } from './config/settings.js';
import { runLoop } from './core/loop.js';
import type { Message } from './core/messages.js';
import { Session } from './core/session.js';
import { buildSystemPrompt } from './core/systemPrompt.js';
import { listModels, PROVIDERS } from './providers/index.js';
import { Router } from './providers/router.js';
import { activeTools } from './tools/registry.js';
import { formatTodos, type Todo } from './tools/todo.js';
import { App } from './ui/App.js';
// esbuild inlines this at build time, so the installed package doesn't read the file at runtime.
import pkg from '../package.json' with { type: 'json' };

const splitList = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Model chain, highest priority first: flags → env (.env) → settings files.
 * An empty chain is allowed: the chat then opens the first-run setup (/provider → /model).
 */
function buildRouter(flags: { model?: string; fallback?: string }, settings: Settings): Router {
  const model = flags.model ?? process.env.JARVIS_MODEL ?? settings.model;
  const fallbacks = flags.fallback
    ? splitList(flags.fallback)
    : process.env.JARVIS_FALLBACKS
      ? splitList(process.env.JARVIS_FALLBACKS)
      : (settings.fallbacks ?? []);
  return new Router({ chain: model ? [model, ...fallbacks] : [], settings });
}

/** Headless: stream the answer to stdout, tool activity to stderr (so stdout stays pipeable). */
interface Conversation {
  session: Session;
  messages: Message[];
  /** True when continuing a saved conversation. */
  resumed: boolean;
}

/** -c → latest conversation here; -r <id> → that one; -r alone → (TUI only) open the picker. */
function pickConversation(cwd: string, opts: { continue?: boolean; resume?: string | boolean }): Conversation {
  const ref = typeof opts.resume === 'string' ? Session.find(cwd, opts.resume) : opts.continue ? Session.latest(cwd) : undefined;
  if (typeof opts.resume === 'string' && !ref) {
    console.error(`No saved conversation with id "${opts.resume}" in this folder.`);
    process.exit(1);
  }
  if (opts.continue && !ref) console.error('No saved conversation in this folder yet; starting a new one.');
  if (!ref) return { session: Session.create(cwd), messages: [], resumed: false };
  const { session, messages } = Session.load(ref.file, cwd);
  return { session, messages, resumed: true };
}

async function runHeadless(prompt: string, router: Router, settings: Settings, conv: Conversation, yes: boolean, usage: boolean) {
  const cwd = process.cwd();
  const messages = conv.messages;
  messages.push({ role: 'user', content: prompt });
  for await (const ev of runLoop(messages, {
    router, cwd, settings,
    system: buildSystemPrompt(cwd),
    tools: activeTools(settings, cwd),
    sessionAllow: [],
    fileState: new Map(),
    session: conv.session,
    // No one to ask in headless mode: --yes approves, otherwise deny (deny rules apply either way).
    askPermission: async () => (yes ? 'allow' : 'deny'),
  })) {
    if (ev.type === 'context') continue;
    if (ev.type === 'text') process.stdout.write(ev.text);
    else if (ev.type === 'tool-call') {
      process.stderr.write(`\n● ${ev.call.name}(${ev.display})\n`);
      if (ev.preview) process.stderr.write(ev.preview.replace(/^/gm, '    ') + '\n');
    }
    else if (ev.type === 'progress') process.stderr.write(`    ↳ ${ev.text}\n`);
    else if (ev.type === 'tool-result' && ev.call.name === 'TodoWrite' && !ev.isError) {
      process.stderr.write(formatTodos((ev.call.args as { todos: Todo[] }).todos).replace(/^/gm, '  ') + '\n');
    } else if (ev.type === 'tool-result') {
      const first = ev.output.split('\n')[0]!.slice(0, 120);
      process.stderr.write(`  ⎿ ${ev.isError ? 'ERROR ' : ''}${first}\n`);
    } else process.stderr.write(`\n[${ev.text}]\n`);
  }
  process.stdout.write('\n');
  if (usage) process.stderr.write(`\n${router.formatUsage()}\n`);
}

const program = new Command()
  .name('jarvis')
  .description('Jarvis: your personal coding assistant, for free and local models')
  .version(pkg.version, '-v, --version')
  .option('-m, --model <ref>', 'model as provider/model-id, e.g. groq/openai/gpt-oss-120b')
  .option('-p, --print <prompt>', 'run one prompt headlessly and print the answer')
  .option('-f, --fallback <refs>', 'comma-separated fallback models, tried in order')
  .option('-y, --yes', 'headless: approve tool calls that would ask (deny rules still apply)')
  .option('--usage', 'headless: print token usage per model at the end')
  .option('-c, --continue', 'continue the most recent conversation in this folder')
  .option('-r, --resume [id]', 'resume a saved conversation (no id: pick from a list)')
  // Extra words are appended to the -p prompt. Why: `npm run dev -- -p "a b c"` on PowerShell
  // loses the quotes, so the prompt arrives as separate arguments.
  .argument('[words...]')
  .action(async (words: string[], opts: {
    model?: string; fallback?: string; print?: string; yes?: boolean; usage?: boolean;
    continue?: boolean; resume?: string | boolean;
  }) => {
    const cwd = process.cwd();
    const settings = loadSettings(cwd);
    const router = buildRouter(opts, settings);
    const conv = pickConversation(cwd, opts);
    if (opts.print) {
      if (router.chain.length === 0) {
        console.error('No model set up yet. Run `jarvis` once to choose a provider and model, or pass --model provider/model.');
        process.exit(1);
      }
      try {
        await runHeadless([opts.print, ...words].join(' '), router, settings, conv, Boolean(opts.yes), Boolean(opts.usage));
      } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        if (opts.usage) console.error(router.formatUsage());
        process.exit(1);
      }
      return;
    }
    render(
      React.createElement(App, {
        router,
        cwd,
        system: buildSystemPrompt(cwd),
        session: conv.session,
        initialMessages: conv.resumed ? conv.messages : undefined,
        openResumePicker: opts.resume === true,
      }),
    );
  });

program
  .command('models <provider>')
  .description(`list a provider's models (${Object.keys(PROVIDERS).join(', ')})`)
  .option('--free', 'only free models (OpenRouter)')
  .action(async (provider: string, opts: { free?: boolean }) => {
    try {
      for (const id of await listModels(provider, opts.free, loadSettings().providers)) console.log(`${provider}/${id}`);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('tools [args...]')
  .description('list tools, enable/disable them, or edit their descriptions')
  .allowUnknownOption() // lets --global / --local through to our parser
  .addHelpText('after', `\n${TOOLS_HELP}`)
  .action(() => {
    try {
      // Raw argv after "tools", so flags like --global reach runToolsCommand untouched.
      console.log(runToolsCommand(process.argv.slice(process.argv.indexOf('tools') + 1)));
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

await program.parseAsync();
