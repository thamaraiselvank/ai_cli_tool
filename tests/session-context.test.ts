import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APICallError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLEARED_PLACEHOLDER,
  clearOldToolResults,
  findCut,
  isContextOverflow,
  manageContext,
  transcriptForSummary,
  type ContextEvent,
} from '../src/core/context.js';
import { runLoop } from '../src/core/loop.js';
import type { Message } from '../src/core/messages.js';
import { projectSlug, Session } from '../src/core/session.js';
import { countTokens } from '../src/core/tokens.js';
import { clearContextWindowCache, getContextWindow } from '../src/providers/modelInfo.js';
import { Router, type Attempt, type ModelResponse } from '../src/providers/router.js';

let home: string;
let cwd: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-proj-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  clearContextWindowCache();
});
afterEach(() => {
  Object.assign(process.env, saved);
  vi.unstubAllGlobals();
  for (const d of [home, cwd]) fs.rmSync(d, { recursive: true, force: true });
});

const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string, calls?: { name: string; args: unknown }[]): Message => ({
  role: 'assistant',
  content,
  toolCalls: calls?.map((c, i) => ({ id: `c${i}`, ...c })),
});
const tool = (content: string): Message => ({ role: 'tool', toolCallId: 'c0', toolName: 'Read', content });

// ---- sessions ----------------------------------------------------------------------------------

describe('Session', () => {
  it('makes a filesystem-safe slug per project', () => {
    expect(projectSlug('/home/me/my app')).toMatch(/^[a-zA-Z0-9-]+$/);
  });

  it('creates no file until there is a message', () => {
    const s = Session.create(cwd);
    s.sync([]);
    expect(fs.existsSync(s.file)).toBe(false);
  });

  it('appends messages and loads them back', () => {
    const s = Session.create(cwd);
    const history: Message[] = [user('fix the bug'), assistant('done')];
    s.sync(history);
    history.push(user('thanks'));
    s.sync(history);
    s.sync(history); // no duplicate
    const { messages } = Session.load(s.file, cwd);
    expect(messages.map((m) => m.content)).toEqual(['fix the bug', 'done', 'thanks']);
  });

  it('replays rewrites (compaction) and keeps appending after them', () => {
    const s = Session.create(cwd);
    s.sync([user('a'), assistant('b'), user('c')]);
    s.rewrite([user('summary'), user('c')]);
    s.sync([user('summary'), user('c'), assistant('d')]);
    expect(Session.load(s.file, cwd).messages.map((m) => m.content)).toEqual(['summary', 'c', 'd']);
  });

  it('survives a half-written last line', () => {
    const s = Session.create(cwd);
    s.sync([user('ok')]);
    fs.appendFileSync(s.file, '{"t":"msg","m":{"role":"us');
    expect(Session.load(s.file, cwd).messages).toHaveLength(1);
  });

  it('lists conversations newest first, titled by the first request', () => {
    const a = Session.create(cwd);
    a.sync([user('first task\nmore detail'), assistant('x')]);
    const b = Session.create(cwd);
    b.sync([user('second task')]);
    fs.utimesSync(a.file, new Date(1000), new Date(1000)); // make a older
    const list = Session.list(cwd);
    expect(list.map((s) => s.title)).toEqual(['second task', 'first task']);
    expect(Session.latest(cwd)?.id).toBe(b.id);
    expect(Session.find(cwd, a.id.slice(0, 4))?.id).toBe(a.id);
  });
});

// ---- context management ---------------------------------------------------------------------------

const big = 'x'.repeat(2000);

describe('clearOldToolResults', () => {
  it('clears all but the last N big tool results and shrinks old tool-call args', () => {
    const msgs: Message[] = [
      user('go'),
      assistant('', [{ name: 'Write', args: { file_path: 'a.ts', content: big } }]),
      tool(big),
      assistant('', [{ name: 'Read', args: { file_path: 'b.ts' } }]),
      tool('tiny'),
      assistant('', [{ name: 'Read', args: { file_path: 'c.ts' } }]),
      tool(big),
    ];
    const changed = clearOldToolResults(msgs, 1);
    expect(msgs[2]!.content).toBe(CLEARED_PLACEHOLDER);
    expect(msgs[4]!.content).toBe('tiny'); // too small to bother
    expect(msgs[6]!.content).toBe(big); // most recent kept
    const args = (msgs[1] as Extract<Message, { role: 'assistant' }>).toolCalls![0]!.args as Record<string, string>;
    expect(args.content).toMatch(/2000 chars cleared/);
    expect(args.file_path).toBe('a.ts');
    expect(changed).toBe(2);
  });
});

describe('findCut', () => {
  it('cuts at the start of the 2nd-last user turn', () => {
    const msgs = [user('1'), assistant('a'), user('2'), assistant('b'), user('3')];
    expect(findCut(msgs)).toBe(2);
  });
  it('returns undefined when there is not enough to summarize', () => {
    expect(findCut([user('1'), assistant('a'), user('2')])).toBeUndefined();
  });
});

describe('transcriptForSummary', () => {
  it('trims tool output and drops the oldest middle to fit, keeping the first request', () => {
    const msgs = [user('THE GOAL'), ...Array.from({ length: 40 }, (_, i) => assistant(`step ${i} ${'y'.repeat(400)}`)), tool(big)];
    const t = transcriptForSummary(msgs, 1500);
    expect(t.startsWith('USER: THE GOAL')).toBe(true);
    expect(t).toMatch(/earlier entries omitted/);
    expect(t).toMatch(/chars trimmed/);
    expect(countTokens(t)).toBeLessThan(1700);
  });
});

it('recognizes "request too large" errors', () => {
  expect(isContextOverflow(new Error('All models failed. Last error: HTTP 413: Request too large'))).toBe(true);
  expect(isContextOverflow(new Error("This model's maximum context length is 8192 tokens"))).toBe(true);
  expect(isContextOverflow(new Error('HTTP 401'))).toBe(false);
});

describe('getContextWindow', () => {
  it('reads the window from the provider, honoring overrides', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [{ id: 'm', context_length: 65536 }] })));
    expect(await getContextWindow('ollama/m', {})).toBe(65536);
    expect(await getContextWindow('ollama/m', { context: { windows: { 'ollama/m': 1000 } } })).toBe(1000);
  });
  it('falls back to a default when the lookup fails', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    expect(await getContextWindow('ollama/x', {})).toBe(32_768);
  });
});

// ---- compaction with a fake model ----------------------------------------------------------------

/** Fake model: returns the scripted replies in order (an Error entry is thrown instead). */
function scripted(replies: (string | Error)[]): { attempt: Attempt; prompts: string[] } {
  const prompts: string[] = [];
  const attempt: Attempt = async function* (model, req) {
    prompts.push(req.messages.map((m) => m.content).join('\n'));
    const next = replies.shift() ?? 'ok';
    if (next instanceof Error) throw next;
    yield next;
    return { text: next, toolCalls: [], model, usage: { input: 0, output: 0, cacheRead: 0 } } satisfies ModelResponse;
  };
  return { attempt, prompts };
}

/** Three turns with lots of text, against a 2,000-token window: forces compaction. */
function longConversation(): Message[] {
  const filler = 'lorem ipsum dolor sit amet '.repeat(100); // ~600 tokens each → ~2,400 total
  return [user(`turn 1 ${filler}`), assistant(`reply 1 ${filler}`), user(`turn 2 ${filler}`), assistant(`reply 2 ${filler}`), user('turn 3')];
}

const tinyWindow = { context: { windows: { 'ollama/m': 2000 } } };

describe('manageContext', () => {
  it('summarizes older turns when over the threshold and records it in the session', async () => {
    const { attempt, prompts } = scripted(['## Goal\nfix stuff']);
    const router = new Router({ chain: ['ollama/m'], settings: tinyWindow, attempt });
    const session = Session.create(cwd);
    const msgs = longConversation();
    session.sync(msgs);

    const events: ContextEvent[] = [];
    for await (const ev of manageContext(msgs, { router, settings: tinyWindow, system: 'sys', toolTokens: 0, session })) events.push(ev);

    expect(prompts[0]).toMatch(/turn 1/); // the summary request saw the old part
    expect(msgs[0]!.content).toMatch(/compacted[\s\S]*fix stuff/);
    expect(msgs.slice(2).map((m) => m.content.slice(0, 6))).toEqual(['turn 2', 'reply ', 'turn 3']);
    expect(events.some((e) => e.type === 'notice' && /Compacted/.test(e.text))).toBe(true);
    expect(Session.load(session.file, cwd).messages).toEqual(msgs);
  });

  it('does not summarize when the older part is tiny and the bulk is the recent turn', async () => {
    const { attempt, prompts } = scripted([]);
    const router = new Router({ chain: ['ollama/m'], settings: tinyWindow, attempt });
    const msgs = [user('hi'), assistant('hello'), user('ok'), assistant('sure'), user(`notes ${'pipeline step '.repeat(700)}`)];
    for await (const _ of manageContext(msgs, { router, settings: tinyWindow, system: 's', toolTokens: 0 })) void _;
    expect(prompts).toEqual([]); // no wasted summary request
    expect(msgs[0]!.content).toBe('hi');
  });

  it('discards a summary that is not smaller than what it replaces', async () => {
    const { attempt } = scripted(['word '.repeat(3000)]);
    const router = new Router({ chain: ['ollama/m'], settings: tinyWindow, attempt });
    const msgs = longConversation();
    const before = JSON.stringify(msgs);
    const notices: string[] = [];
    for await (const ev of manageContext(msgs, { router, settings: tinyWindow, system: 's', toolTokens: 0 }, { compact: true })) {
      if (ev.type === 'notice') notices.push(ev.text);
    }
    expect(JSON.stringify(msgs)).toBe(before);
    expect(notices.some((n) => /Skipped compaction/.test(n))).toBe(true);
  });

  it('does nothing below the thresholds', async () => {
    const { attempt, prompts } = scripted([]);
    const router = new Router({ chain: ['ollama/m'], settings: {}, attempt });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [{ id: 'm', context_length: 100_000 }] })));
    const msgs = longConversation();
    const before = JSON.stringify(msgs);
    for await (const _ of manageContext(msgs, { router, settings: {}, system: 's', toolTokens: 0 })) void _;
    expect(prompts).toEqual([]);
    expect(JSON.stringify(msgs)).toBe(before);
  });
});

describe('runLoop overflow recovery', () => {
  it('compacts and retries once when the provider says the request is too large', async () => {
    const tooLarge = new APICallError({
      message: 'too large', url: 'x', requestBodyValues: {}, statusCode: 413, responseBody: 'Request too large',
    });
    // 1st call: rejected · 2nd: the summary · 3rd: the real answer
    const { attempt } = scripted([tooLarge, 'SUMMARY', 'final answer']);
    // Big window so the proactive check doesn't compact first; the provider "disagrees".
    const settings = { context: { windows: { 'ollama/m': 1_000_000 } } };
    const router = new Router({ chain: ['ollama/m'], settings, attempt, sleep: async () => {} });
    const msgs = longConversation();
    const texts: string[] = [];
    for await (const ev of runLoop(msgs, {
      router, settings, system: 's', tools: [], cwd, sessionAllow: [], fileState: new Map(),
      askPermission: async () => 'deny',
    })) {
      if (ev.type === 'notice') texts.push(ev.text);
    }
    expect(texts.some((t) => /too large/.test(t))).toBe(true);
    expect(msgs[0]!.content).toMatch(/SUMMARY/);
    expect(msgs.at(-1)!.content).toBe('final answer');
  });
});
