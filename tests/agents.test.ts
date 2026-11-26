import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentToolNames, BUILTIN_AGENTS, loadAgents, parseAgentFile, parseFrontmatter } from '../src/agents/index.js';
import { runLoop, type LoopEvent } from '../src/core/loop.js';
import { appendMemory, formatMemory, loadMemory, MAX_MEMORY_CHARS } from '../src/core/memory.js';
import type { Message, ToolCall } from '../src/core/messages.js';
import { buildSystemPrompt } from '../src/core/systemPrompt.js';
import { checkPermission } from '../src/permissions/index.js';
import { Router, type Attempt, type ModelResponse } from '../src/providers/router.js';
import { activeTools } from '../src/tools/registry.js';
import { createTaskTool } from '../src/tools/task.js';
import { formatTodos, latestTodos, TodoWriteTool } from '../src/tools/todo.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agents-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function dir(name: string): string {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ---- agent files ---------------------------------------------------------------------------------

describe('agent definitions', () => {
  it('parses frontmatter with lists and quotes', () => {
    const { data, body } = parseFrontmatter('---\nname: rev\ndescription: "Reviews diffs"\ntools: [Read, Grep]\n---\nBe strict.\n');
    expect(data).toEqual({ name: 'rev', description: 'Reviews diffs', tools: '[Read, Grep]' });
    expect(body).toBe('Be strict.');
  });

  it('builds an agent from a file, defaulting the name to the file name', () => {
    const a = parseAgentFile(path.join('x', 'reviewer.md'), '---\r\ndescription: Reviews\r\ntools: Read, Grep\r\nmodel: groq/m\r\n---\r\nCheck it.');
    expect(a).toMatchObject({ name: 'reviewer', description: 'Reviews', tools: ['Read', 'Grep'], model: 'groq/m' });
    expect(a.prompt).toMatch(/^Check it\./);
  });

  it('rejects files without a description or prompt', () => {
    expect(() => parseAgentFile('a.md', '---\nname: a\n---\nbody')).toThrow(/description/);
    expect(() => parseAgentFile('a.md', '---\ndescription: d\n---\n')).toThrow(/empty/);
  });

  it('loads project agents, lets them override built-ins, and reports broken files', () => {
    const cwd = dir('proj-agents');
    const agentsDir = path.join(cwd, '.jarvis', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'explore.md'), '---\ndescription: My explorer\ntools: Grep\n---\nSearch.');
    fs.writeFileSync(path.join(agentsDir, 'broken.md'), 'no frontmatter at all');
    const { agents, errors } = loadAgents(cwd);
    expect(agents.find((a) => a.name === 'explore')?.description).toBe('My explorer');
    expect(agents.some((a) => a.name === 'general')).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it('never gives a sub-agent Task or TodoWrite, and respects disabled tools', () => {
    const general = BUILTIN_AGENTS.find((a) => a.name === 'general')!;
    expect(agentToolNames(general, ['Read', 'Bash', 'Task', 'TodoWrite'])).toEqual(['Read', 'Bash']);
    const explore = BUILTIN_AGENTS.find((a) => a.name === 'explore')!;
    expect(agentToolNames(explore, ['Read', 'Bash'])).toEqual(['Read']); // Glob/Grep disabled
  });
});

// ---- Task tool -----------------------------------------------------------------------------------

describe('Task tool', () => {
  const task = createTaskTool({
    agents: BUILTIN_AGENTS,
    enabledTools: ['Read', 'Glob', 'Grep', 'Bash'],
    readOnlyTools: new Set(['Read', 'Glob', 'Grep']),
  });
  const ctx = { cwd: tmp, settings: {}, sessionAllow: [] as string[] };

  it('runs read-only agents without asking, asks for agents that can change things', () => {
    expect(checkPermission(task, { agent: 'explore', description: 'd', prompt: 'p' }, ctx)).toBe('allow');
    expect(checkPermission(task, { agent: 'general', description: 'd', prompt: 'p' }, ctx)).toBe('ask');
  });

  it('lists agents in its description and rejects unknown ones before any prompt', async () => {
    expect(task.description).toMatch(/- explore:/);
    await expect(task.preview!({ agent: 'nope', description: 'd', prompt: 'p' }, { cwd: tmp })).rejects.toThrow(/Unknown agent/);
  });

  it('is rebuilt with project agents by activeTools(settings, cwd)', () => {
    const cwd = dir('proj-task');
    fs.mkdirSync(path.join(cwd, '.jarvis', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.jarvis', 'agents', 'docs.md'), '---\ndescription: Writes docs\n---\nWrite docs.');
    const t = activeTools({}, cwd).find((x) => x.name === 'Task')!;
    expect(t.description).toMatch(/- docs: Writes docs/);
  });
});

// ---- sub-agent run through the real loop, with a fake model -------------------------------------

type Turn = { text?: string; calls?: Omit<ToolCall, 'id'>[] };

/**
 * Fake model that answers by role: the parent (main system prompt) and the explore sub-agent get
 * separate scripts. Records which model served each request.
 */
function fakeModel(parent: Turn[], child: Turn[]) {
  const served: { model: string; who: 'parent' | 'child' }[] = [];
  let n = 0;
  const attempt: Attempt = async function* (model, req) {
    const who = req.system.includes('code search specialist') ? 'child' : 'parent';
    served.push({ model, who });
    const turn = (who === 'child' ? child : parent).shift() ?? { text: 'ok' };
    if (turn.text) yield turn.text;
    return {
      text: turn.text ?? '',
      toolCalls: (turn.calls ?? []).map((c) => ({ ...c, id: `c${n++}` })),
      model,
      usage: { input: 0, output: 0, cacheRead: 0 },
    } satisfies ModelResponse;
  };
  return { attempt, served };
}

describe('sub-agents in the loop', () => {
  const cwd = dir('loop');
  fs.writeFileSync(path.join(cwd, 'auth.ts'), 'export const login = 1;\n');
  const settings = {
    agents: { model: 'ollama/cheap' },
    context: { windows: { 'ollama/main': 1_000_000, 'ollama/cheap': 1_000_000 } },
  };

  it('delegates, streams progress, and returns only the report to the parent', async () => {
    const { attempt, served } = fakeModel(
      [
        { calls: [{ name: 'Task', args: { agent: 'explore', description: 'Find login', prompt: 'Where is login?' } }] },
        { text: 'Login is in auth.ts:1.' },
      ],
      [{ calls: [{ name: 'Glob', args: { pattern: '**/*.ts' } }] }, { text: 'Found: auth.ts:1 defines login.' }],
    );
    const router = new Router({ chain: ['ollama/main'], settings, attempt });
    const messages: Message[] = [{ role: 'user', content: 'find login' }];
    const events: LoopEvent[] = [];
    for await (const ev of runLoop(messages, {
      router, settings, cwd,
      system: buildSystemPrompt(cwd),
      tools: activeTools(settings, cwd),
      sessionAllow: [],
      fileState: new Map(),
      askPermission: async () => 'deny', // nothing here should need asking
    })) events.push(ev);

    // The parent's history holds the report, not the child's Glob output.
    const result = messages.find((m) => m.role === 'tool');
    expect(result).toMatchObject({ toolName: 'Task', content: 'Found: auth.ts:1 defines login.', isError: false });
    expect(messages.some((m) => m.role === 'tool' && m.toolName === 'Glob')).toBe(false);
    expect(events.some((e) => e.type === 'progress' && /^Glob\(/.test(e.text))).toBe(true);
    // Child text must not stream into the parent's reply.
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Login is in auth.ts:1.');
    // The sub-agent used agents.model; the parent stayed on its own model.
    expect(served.filter((s) => s.who === 'child').every((s) => s.model === 'ollama/cheap')).toBe(true);
    expect(served.filter((s) => s.who === 'parent').every((s) => s.model === 'ollama/main')).toBe(true);
    expect(router.lastModel).toBe('ollama/main');
  });

  it('turns an unknown agent into a tool error the model can fix', async () => {
    const { attempt } = fakeModel(
      [{ calls: [{ name: 'Task', args: { agent: 'wizard', description: 'x', prompt: 'y' } }] }, { text: 'sorry' }],
      [],
    );
    const router = new Router({ chain: ['ollama/main'], settings, attempt });
    const messages: Message[] = [{ role: 'user', content: 'go' }];
    for await (const _ of runLoop(messages, {
      router, settings, cwd, system: 's', tools: activeTools(settings, cwd), sessionAllow: [], fileState: new Map(),
      askPermission: async () => { throw new Error('should not ask'); },
    })) void _;
    expect(messages.find((m) => m.role === 'tool')).toMatchObject({ isError: true, content: expect.stringMatching(/Unknown agent/) });
  });
});

// ---- TodoWrite -----------------------------------------------------------------------------------

describe('TodoWrite', () => {
  const todos = [
    { content: 'Read the parser', status: 'completed' as const },
    { content: 'Fix the bug', status: 'in_progress' as const },
    { content: 'Add a test', status: 'pending' as const },
  ];

  it('summarizes progress and nudges when several items are in progress', async () => {
    expect(await TodoWriteTool.run({ todos }, { cwd: tmp })).toMatch(/1\/3 completed/);
    const two = todos.map((t) => ({ ...t, status: 'in_progress' as const }));
    expect(await TodoWriteTool.run({ todos: two }, { cwd: tmp })).toMatch(/more than one/);
  });

  it('formats a checklist', () => {
    expect(formatTodos(todos)).toBe('☑ Read the parser\n◐ Fix the bug\n☐ Add a test');
  });

  it('finds the latest successful list in the history', () => {
    const messages: Message[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'TodoWrite', args: { todos } }] },
      { role: 'tool', toolCallId: 'a', toolName: 'TodoWrite', content: 'ok' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'TodoWrite', args: { todos: [{ content: 'bad', status: 'x' }] } }] },
      { role: 'tool', toolCallId: 'b', toolName: 'TodoWrite', content: 'Invalid', isError: true },
    ];
    expect(latestTodos(messages)).toEqual(todos);
    expect(latestTodos([])).toBeUndefined();
  });
});

// ---- JARVIS.md memory ----------------------------------------------------------------------------

describe('JARVIS.md memory', () => {
  const home = dir('home');
  fs.mkdirSync(path.join(home, '.jarvis'), { recursive: true });
  fs.writeFileSync(path.join(home, '.jarvis', 'JARVIS.md'), 'Personal: be brief.');

  const repo = dir('repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'JARVIS.md'), 'Repo: use pnpm.');
  const pkg = path.join(repo, 'packages', 'web');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'JARVIS.md'), 'Web: tests in e2e/.');
  fs.writeFileSync(path.join(pkg, 'JARVIS.local.md'), 'Local: my port is 3001.');

  it('loads personal, repo-root → cwd, then local files, in that order', () => {
    const files = loadMemory(pkg, home).map((f) => f.content);
    expect(files).toEqual(['Personal: be brief.', 'Repo: use pnpm.', 'Web: tests in e2e/.', 'Local: my port is 3001.']);
  });

  it('goes into the system prompt between the instructions and the env block', () => {
    const prompt = buildSystemPrompt(pkg, { home });
    const mem = prompt.indexOf('Repo: use pnpm.');
    expect(mem).toBeGreaterThan(prompt.indexOf('You are Jarvis'));
    expect(mem).toBeLessThan(prompt.indexOf('<env>'));
  });

  it('caps huge files and adds nothing when there is no memory', () => {
    const big = dir('big');
    fs.writeFileSync(path.join(big, 'JARVIS.md'), 'x'.repeat(MAX_MEMORY_CHARS + 10));
    const [f] = loadMemory(big, dir('empty-home'));
    expect(f!.truncated).toBe(true);
    expect(formatMemory([f!])).toMatch(/truncated/);
    expect(formatMemory([])).toBe('');
  });

  it('/memory add appends a bullet, creating the file if needed', () => {
    const d = dir('add');
    appendMemory(d, 'Run tests with npm test');
    appendMemory(d, 'Prefer small commits');
    expect(fs.readFileSync(path.join(d, 'JARVIS.md'), 'utf8')).toBe(
      '# Project notes for Jarvis\n\n- Run tests with npm test\n- Prefer small commits\n',
    );
  });
});
