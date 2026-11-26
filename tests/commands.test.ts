import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findCommand, matchCommands } from '../src/commands/index.js';
import { chooseMainModel } from '../src/commands/model.js';
import type { CommandContext } from '../src/commands/types.js';
import { maskKey } from '../src/config/credentials.js';
import { Session } from '../src/core/session.js';
import { loadSettings } from '../src/config/settings.js';
import { isChatModel } from '../src/providers/index.js';
import { Router } from '../src/providers/router.js';

let home: string;
let cwd: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, JARVIS_MODEL: process.env.JARVIS_MODEL };

// Point "home" at a temp dir so tests never touch your real ~/.jarvis.
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-proj-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.JARVIS_MODEL;
});
afterEach(() => {
  Object.assign(process.env, saved);
  for (const d of [home, cwd]) fs.rmSync(d, { recursive: true, force: true });
});

function fakeCtx(router: Router) {
  const printed: string[] = [];
  const ctx: CommandContext = {
    cwd,
    router,
    print: (t) => printed.push(t),
    conversation: {
      messages: () => [],
      session: () => Session.create(cwd),
      system: 's',
      startNew: () => {},
      load: () => {},
    },
    exit: () => {},
    ui: { select: async () => undefined, multiSelect: async () => undefined, input: async () => undefined },
  };
  return { ctx, printed };
}

describe('command registry', () => {
  it('finds commands by name or alias', () => {
    expect(findCommand('login')?.name).toBe('provider');
    expect(findCommand('quit')?.name).toBe('exit');
    expect(findCommand('nope')).toBeUndefined();
  });
  it('autocompletes by prefix', () => {
    expect(matchCommands('mo').map((c) => c.name)).toEqual(['model']);
    expect(matchCommands('').length).toBeGreaterThan(5);
  });
});

describe('/model', () => {
  it('puts the new model first, keeps the rest as fallbacks, and saves it globally', async () => {
    const router = new Router({ chain: ['groq/a', 'groq/b'], settings: {} });
    const { ctx } = fakeCtx(router);
    expect(await chooseMainModel(ctx, 'groq/b')).toBe(true);
    expect(router.chain).toEqual(['groq/b', 'groq/a']);
    expect(loadSettings(cwd).model).toBe('groq/b');
  });
  it('rejects a malformed model name', async () => {
    const { ctx } = fakeCtx(new Router({ chain: [], settings: {} }));
    await expect(chooseMainModel(ctx, 'llama3')).rejects.toThrow(/provider\/model-id/);
  });
});

describe('/permissions', () => {
  it('adds and removes rules in the local settings file', async () => {
    const { ctx } = fakeCtx(new Router({ chain: [], settings: {} }));
    await findCommand('permissions')!.run(['allow', 'Bash(git', 'status)'], ctx);
    expect(loadSettings(cwd).permissions?.allow).toEqual(['Bash(git status)']);
    await findCommand('permissions')!.run(['remove', 'Bash(git', 'status)'], ctx);
    expect(loadSettings(cwd).permissions?.allow).toEqual([]);
  });
});

describe('helpers', () => {
  it('masks keys', () => {
    expect(maskKey('gsk_1234567890abcdef')).toBe('gsk_…cdef');
  });
  it('hides non-chat models from pickers', () => {
    expect(isChatModel('openai/gpt-oss-120b')).toBe(true);
    expect(isChatModel('whisper-large-v3')).toBe(false);
    expect(isChatModel('meta-llama/llama-prompt-guard-2-22m')).toBe(false);
  });
});
