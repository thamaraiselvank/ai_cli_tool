import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseAdd } from '../src/commands/mcp.js';
import { mergeSettings } from '../src/config/settings.js';
import { runLoop } from '../src/core/loop.js';
import type { Message } from '../src/core/messages.js';
import {
  expandEnv,
  formatToolResult,
  makeConnector,
  McpManager,
  mcpToolName,
  type Connector,
} from '../src/mcp/client.js';
import { checkPermission, ruleMatches } from '../src/permissions/index.js';
import { Router, type Attempt, type ModelResponse } from '../src/providers/router.js';
import { activeTools, toolParameters } from '../src/tools/registry.js';

const cwd = process.cwd();
const managers: McpManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

/** A real MCP server (SDK) connected in memory: no processes, but the full protocol. */
function testServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  server.registerTool(
    'search',
    { description: 'Search notes', inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
    async ({ query }) => ({ content: [{ type: 'text', text: `found 2 notes for "${query}"` }] }),
  );
  server.registerTool('fail', { description: 'Always fails' }, async () => ({
    content: [{ type: 'text', text: 'quota exceeded' }],
    isError: true,
  }));
  return server;
}

const inMemory = (make: () => McpServer = testServer): Connector => async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await make().connect(serverSide);
  const client = new Client({ name: 'jarvis-test', version: '0' });
  await client.connect(clientSide);
  return { client };
};

function manager(servers: Record<string, object>, connect: Connector, connectTimeoutMs?: number) {
  const m = new McpManager(servers, { cwd, connect, connectTimeoutMs });
  managers.push(m);
  return m;
}

// ---- helpers -------------------------------------------------------------------------------------

describe('config helpers', () => {
  it('expands ${VAR} and ${VAR:-default}, collecting missing ones', () => {
    const missing = new Set<string>();
    expect(expandEnv('Bearer ${TOKEN}', { TOKEN: 'abc' }, missing)).toBe('Bearer abc');
    expect(expandEnv('${PORT:-3000}', {}, missing)).toBe('3000');
    expect(expandEnv('${NOPE}', {}, missing)).toBe('');
    expect([...missing]).toEqual(['NOPE']);
  });

  it('builds safe, bounded tool names', () => {
    expect(mcpToolName('my server', 'get.issue')).toBe('mcp__my_server__get_issue');
    expect(mcpToolName('s', 'x'.repeat(100))).toHaveLength(64);
  });

  it('formats tool results as text and throws on isError', () => {
    expect(formatToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] }))
      .toMatch(/^a\n\[image image\/png, 0 KB — not shown\]$/);
    expect(formatToolResult({ content: [], structuredContent: { n: 1 } })).toContain('"n": 1');
    expect(formatToolResult({ content: [] })).toBe('(no output)');
    expect(() => formatToolResult({ content: [{ type: 'text', text: 'boom' }], isError: true })).toThrow('boom');
  });

  it('lets a more specific settings file replace a whole server definition', () => {
    const merged = mergeSettings(
      { mcpServers: { gh: { command: 'npx', args: ['-y', 'old'] }, fs: { command: 'fs' } } },
      { mcpServers: { gh: { command: 'npx', args: ['-y', 'new'] } } },
    );
    expect(merged.mcpServers).toEqual({ gh: { command: 'npx', args: ['-y', 'new'] }, fs: { command: 'fs' } });
  });

  it('matches wildcard tool rules', () => {
    expect(ruleMatches('mcp__github__*', 'mcp__github__create_issue', '')).toBe(true);
    expect(ruleMatches('mcp__github__*', 'mcp__gitlab__x', '')).toBe(false);
    expect(ruleMatches('mcp__notes__search', 'mcp__notes__search', '')).toBe(true);
  });

  it('parses `mcp add` arguments', () => {
    expect(parseAdd(['fs', '--env', 'A=${B}', '--', 'npx', '-y', 'pkg', '--global'])).toEqual({
      name: 'fs',
      config: { command: 'npx', args: ['-y', 'pkg', '--global'], env: { A: '${B}' } },
    });
    expect(parseAdd(['gh', '--url', 'https://x/mcp', '--header', 'Authorization: Bearer ${T}'])).toEqual({
      name: 'gh',
      config: { url: 'https://x/mcp', headers: { Authorization: 'Bearer ${T}' } },
    });
    expect(() => parseAdd(['x'])).toThrow(/command/);
    expect(() => parseAdd(['bad name!', '--', 'a'])).toThrow(/letters/);
  });
});

// ---- manager -------------------------------------------------------------------------------------

describe('McpManager', () => {
  it('turns server tools into Jarvis tools with the server schema', async () => {
    const m = manager({ notes: {} }, inMemory());
    await m.start();
    const [s] = m.servers();
    expect(s).toMatchObject({ name: 'notes', status: 'connected' });
    const search = m.tools().find((t) => t.name === 'mcp__notes__search')!;
    expect(search.description).toBe('[MCP notes] Search notes');
    expect(search.readOnly).toBe(true);
    expect(toolParameters(search)).toMatchObject({ type: 'object', properties: { query: { type: 'string' } } });
    expect(await search.run({ query: 'mcp' }, { cwd })).toBe('found 2 notes for "mcp"');
    await expect(m.tools().find((t) => t.name === 'mcp__notes__fail')!.run({}, { cwd })).rejects.toThrow('quota exceeded');
  });

  it('asks before running MCP tools even when they claim to be read-only', async () => {
    const m = manager({ notes: {} }, inMemory());
    await m.start();
    const search = m.tools()[0]!;
    const ctx = { cwd, sessionAllow: [] as string[] };
    expect(checkPermission(search, { query: 'x' }, { ...ctx, settings: {} })).toBe('ask');
    expect(checkPermission(search, { query: 'x' }, { ...ctx, settings: { permissions: { allow: ['mcp__notes__*'] } } })).toBe('allow');
    // "always" answers store Tool() (empty key), which then covers any args.
    expect(checkPermission(search, { query: 'y' }, { ...ctx, settings: {}, sessionAllow: ['mcp__notes__search()'] })).toBe('allow');
  });

  it('reports a failing server without affecting the others', async () => {
    const connect: Connector = async (name, ...rest) => {
      if (name === 'broken') throw new Error('spawn nope ENOENT');
      return inMemory()(name, ...rest);
    };
    const m = manager({ broken: {}, notes: {}, off: { disabled: true } }, connect);
    await m.start();
    expect(m.servers().map((s) => [s.name, s.status])).toEqual([['broken', 'failed'], ['notes', 'connected'], ['off', 'disabled']]);
    expect(m.servers()[0]!.error).toMatch(/ENOENT/);
    expect(m.tools().every((t) => t.name.startsWith('mcp__notes__'))).toBe(true);
  });

  it('gives up on a server that never answers', async () => {
    const m = manager({ slow: {} }, () => new Promise(() => {}), 50);
    await m.start();
    expect(m.servers()[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/no response/) });
  });

  it('honors tools.disabled for MCP tools', async () => {
    const m = manager({ notes: {} }, inMemory());
    await m.start();
    const names = activeTools({ tools: { disabled: ['mcp__notes__fail'] } }, cwd, m.tools()).map((t) => t.name);
    expect(names).toContain('mcp__notes__search');
    expect(names).not.toContain('mcp__notes__fail');
  });

  it('runs an MCP tool through the agentic loop', async () => {
    const m = manager({ notes: {} }, inMemory());
    await m.start();
    let n = 0;
    const attempt: Attempt = async function* (model) {
      const first = n++ === 0;
      if (!first) yield 'done';
      return {
        text: first ? '' : 'done',
        toolCalls: first ? [{ id: 't1', name: 'mcp__notes__search', args: { query: 'loop' } }] : [],
        model,
        usage: { input: 0, output: 0, cacheRead: 0 },
      } satisfies ModelResponse;
    };
    const settings = { context: { windows: { 'ollama/m': 1_000_000 } } };
    const router = new Router({ chain: ['ollama/m'], settings, attempt });
    const messages: Message[] = [{ role: 'user', content: 'search' }];
    const asked: string[] = [];
    for await (const _ of runLoop(messages, {
      router, settings, cwd, system: 's', tools: activeTools(settings, cwd, m.tools()), sessionAllow: [], fileState: new Map(),
      askPermission: async (call) => {
        asked.push(call.name);
        return 'allow';
      },
    })) void _;
    expect(asked).toEqual(['mcp__notes__search']);
    expect(messages.find((x) => x.role === 'tool')).toMatchObject({ content: 'found 2 notes for "loop"', isError: false });
  });
});

describe('stdio transport (real child process)', () => {
  it('starts a server process, passes env, calls a tool and stops it', async () => {
    const script = path.join(cwd, 'tests', 'fixtures', 'mcp-echo-server.mjs');
    const m = manager(
      { echo: { command: process.execPath, args: [script], env: { ECHO_PREFIX: '${JARVIS_TEST_PREFIX:-from-settings}' } } },
      makeConnector('test'),
    );
    await m.start();
    expect(m.servers()[0]).toMatchObject({ status: 'connected' });
    expect(await m.tools()[0]!.run({ text: 'hi' }, { cwd })).toBe('echo: hi (from-settings)');
    await m.close();
  }, 30_000);

  it('explains a command that does not exist', async () => {
    const m = manager({ ghost: { command: 'definitely-not-a-real-command-xyz' } }, makeConnector('test'), 15_000);
    await m.start();
    expect(m.servers()[0]!.status).toBe('failed');
  }, 30_000);

  it('refuses to start with a missing env var', async () => {
    const m = manager({ gh: { command: 'npx', env: { TOKEN: '${JARVIS_SURELY_UNSET_VAR}' } } }, makeConnector('test'));
    await m.start();
    expect(m.servers()[0]!.error).toMatch(/missing environment variable: JARVIS_SURELY_UNSET_VAR/);
  });
});
