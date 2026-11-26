import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type { McpServerConfig } from '../config/settings.js';
import type { Tool } from '../tools/types.js';

/**
 * MCP client: turns the tools of configured MCP servers into ordinary Jarvis tools.
 *
 * Why this shape: the loop, permissions, output caps and sub-agents already work on `Tool`
 * objects, so an MCP tool is just a Tool whose `run` forwards to the server. Nothing else in the
 * app needs to know MCP exists. Names are `mcp__<server>__<tool>` so rules like
 * `mcp__github__*` can allow or deny a whole server.
 */

export type ServerStatus = 'connecting' | 'connected' | 'failed' | 'disabled';
export type TransportKind = 'stdio' | 'http' | 'sse';

export interface ServerState {
  name: string;
  status: ServerStatus;
  transport: TransportKind;
  error?: string;
  tools: Tool[];
  /** The server's own usage notes (from initialize), if it sent any. */
  instructions?: string;
}

/** A live connection. Injected in tests (in-memory server); real ones come from `connectServer`. */
export interface Connection {
  client: Client;
  /** Last few KB of the process's stderr, to explain a failed start. */
  stderr?: () => string;
}

export type Connector = (name: string, cfg: McpServerConfig, cwd: string) => Promise<Connection>;

export const CONNECT_TIMEOUT_MS = 60_000; // first `npx` run may download the package
const DEFAULT_CALL_TIMEOUT_S = 120;
const MAX_NAME = 64; // OpenAI-style APIs reject longer function names
const MAX_DESCRIPTION = 2000;

// ---- config helpers ------------------------------------------------------------------------------

export function transportKind(cfg: McpServerConfig): TransportKind {
  if (cfg.type) return cfg.type;
  return cfg.url ? 'http' : 'stdio';
}

/**
 * "${VAR}" / "${VAR:-default}" → value from the environment. Missing variables without a default
 * are collected so the server fails with a clear message instead of starting with an empty token.
 */
export function expandEnv(value: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
    const v = env[name];
    if (v !== undefined && v !== '') return v;
    if (def !== undefined) return def;
    missing.add(name);
    return '';
  });
}

function expandAll(cfg: McpServerConfig, env: NodeJS.ProcessEnv): McpServerConfig {
  const missing = new Set<string>();
  const x = (s: string) => expandEnv(s, env, missing);
  const map = (r?: Record<string, string>) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, x(v)])) : undefined);
  const out: McpServerConfig = {
    ...cfg,
    command: cfg.command && x(cfg.command),
    args: cfg.args?.map(x),
    env: map(cfg.env),
    url: cfg.url && x(cfg.url),
    headers: map(cfg.headers),
  };
  if (missing.size) throw new Error(`missing environment variable${missing.size > 1 ? 's' : ''}: ${[...missing].join(', ')}`);
  return out;
}

/** Tool names may only use [A-Za-z0-9_-] and must fit 64 chars. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, MAX_NAME);
}

// ---- the real connector --------------------------------------------------------------------------

export function makeConnector(version: string): Connector {
  return async (name, raw, cwd) => {
    const cfg = expandAll(raw, process.env);
    const kind = transportKind(cfg);
    let transport: Transport;
    let stderr = '';

    if (kind === 'stdio') {
      if (!cfg.command) throw new Error('needs "command" (or "url" for a remote server)');
      const t = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        // Only a safe base set (PATH, HOME, SYSTEMROOT, …) plus what the user listed: we don't hand
        // every API key in our environment to a third-party process.
        env: { ...getDefaultEnvironment(), ...cfg.env },
        cwd: cfg.cwd ? path.resolve(cwd, cfg.cwd) : cwd,
        // Piped, not inherited: server logs would otherwise scribble over the TUI.
        stderr: 'pipe',
      });
      t.stderr?.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      transport = t;
    } else {
      if (!cfg.url) throw new Error(`needs "url" for type "${kind}"`);
      const url = new URL(cfg.url);
      const requestInit = cfg.headers ? { headers: cfg.headers } : undefined;
      transport = kind === 'sse' ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit });
    }

    const client = new Client({ name: 'jarvis', version });
    try {
      await client.connect(transport);
    } catch (e) {
      await client.close().catch(() => {});
      const tail = stderr.trim().split('\n').slice(-5).join('\n');
      throw new Error(`${(e as Error).message}${tail ? `\n${tail}` : ''}`);
    }
    return { client, stderr: () => stderr };
  };
}

// ---- MCP tool → Jarvis tool ----------------------------------------------------------------------

/** Args are validated by the server against its own schema; we only insist on an object. */
const ANY_ARGS = z.preprocess((v) => v ?? {}, z.record(z.string(), z.unknown()));

interface McpToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; title?: string };
}

type ContentItem =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: 'resource_link'; uri: string; name?: string }
  | { type: string; [k: string]: unknown };

/** MCP results are content arrays; the model gets plain text (binary parts become a short note). */
export function formatToolResult(res: { content?: unknown; structuredContent?: unknown; isError?: boolean; toolResult?: unknown }): string {
  const parts: string[] = [];
  for (const c of (Array.isArray(res.content) ? res.content : []) as ContentItem[]) {
    if (c.type === 'text') parts.push(String(c.text));
    else if (c.type === 'image' || c.type === 'audio') {
      const kb = Math.round((String(c.data ?? '').length * 3) / 4 / 1024);
      parts.push(`[${c.type} ${String(c.mimeType)}, ${kb} KB — not shown]`);
    } else if (c.type === 'resource') {
      const r = c.resource as { uri: string; text?: string };
      parts.push(r.text ?? `[binary resource ${r.uri}]`);
    } else if (c.type === 'resource_link') parts.push(`[resource ${String(c.uri)}]`);
    else parts.push(JSON.stringify(c));
  }
  if (!parts.length && res.structuredContent !== undefined) parts.push(JSON.stringify(res.structuredContent, null, 2));
  if (!parts.length && res.toolResult !== undefined) parts.push(JSON.stringify(res.toolResult, null, 2)); // pre-2025 servers
  const text = parts.join('\n') || '(no output)';
  if (res.isError) throw new Error(text);
  return text;
}

/** Providers want an object schema; some servers omit `properties` for no-arg tools. */
function normalizeSchema(s: Record<string, unknown> | undefined): Record<string, unknown> {
  const schema = { ...(s ?? {}) };
  if (schema.type !== 'object') schema.type = 'object';
  if (!schema.properties) schema.properties = {};
  return schema;
}

export function toJarvisTool(server: string, def: McpToolDef, client: Client, cfg: McpServerConfig): Tool {
  const timeout = (cfg.timeout ?? DEFAULT_CALL_TIMEOUT_S) * 1000;
  const desc = (def.description || def.title || def.annotations?.title || def.name).slice(0, MAX_DESCRIPTION);
  return {
    name: mcpToolName(server, def.name),
    description: `[MCP ${server}] ${desc}`,
    schema: ANY_ARGS,
    parameters: normalizeSchema(def.inputSchema),
    // The hint only decides parallel execution. Permission still asks (defaultPermission below):
    // annotations come from the server and the MCP spec says not to trust them for safety.
    readOnly: def.annotations?.readOnlyHint === true,
    defaultPermission: 'ask',
    loading: 'always',
    // Empty key: "always allow" then covers every call of this tool, which is what people expect
    // for e.g. a search tool (args differ every call).
    permissionKey: () => '',
    async preview(args) {
      const json = JSON.stringify(args, null, 2);
      return json === '{}' ? '' : json;
    },
    async run(args, ctx) {
      const res = await client.callTool({ name: def.name, arguments: args as Record<string, unknown> }, undefined, {
        signal: ctx.abortSignal,
        timeout,
      });
      return formatToolResult(res);
    },
  };
}

// ---- manager -------------------------------------------------------------------------------------

interface Entry extends ServerState {
  config: McpServerConfig;
  connection?: Connection;
}

export interface McpManagerOptions {
  cwd: string;
  connect: Connector;
  connectTimeoutMs?: number;
}

/**
 * Owns every server connection for the app's lifetime. Servers start in parallel in the
 * background, so a slow `npx` download doesn't delay the TUI; the first message waits for them
 * (bounded by the connect timeout). A failing server is reported, never fatal.
 */
export class McpManager {
  private readonly entries = new Map<string, Entry>();
  private starting?: Promise<void>;

  constructor(servers: Record<string, McpServerConfig>, private readonly opts: McpManagerOptions) {
    for (const [name, config] of Object.entries(servers)) {
      this.entries.set(name, {
        name,
        config,
        transport: transportKind(config),
        status: config.disabled ? 'disabled' : 'connecting',
        tools: [],
      });
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Connect every enabled server. Safe to call repeatedly; never rejects. */
  start(): Promise<void> {
    this.starting ??= Promise.all([...this.entries.values()].filter((e) => !e.config.disabled).map((e) => this.connect(e))).then(() => {});
    return this.starting;
  }

  /** True once every server has connected or failed. */
  get settled(): boolean {
    return [...this.entries.values()].every((e) => e.status !== 'connecting');
  }

  private async connect(e: Entry): Promise<void> {
    e.status = 'connecting';
    e.error = undefined;
    e.tools = [];
    let timer: NodeJS.Timeout | undefined;
    let connection: Connection | undefined;
    try {
      const timeoutMs = this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
      const pending = this.opts.connect(e.name, e.config, this.opts.cwd);
      // If we give up waiting, still close the connection should it arrive later.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          pending.then((c) => c.client.close()).catch(() => {});
          reject(new Error(`no response after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      });
      connection = await Promise.race([pending, timeout]);

      const defs: McpToolDef[] = [];
      let cursor: string | undefined;
      do {
        const page = await connection.client.listTools(cursor ? { cursor } : undefined);
        defs.push(...(page.tools as McpToolDef[]));
        cursor = page.nextCursor;
      } while (cursor);

      const client = connection.client;
      e.connection = connection;
      e.tools = defs.map((d) => toJarvisTool(e.name, d, client, e.config));
      e.instructions = client.getInstructions();
      e.status = 'connected';
    } catch (err) {
      await connection?.client.close().catch(() => {});
      e.status = 'failed';
      e.error = (err as Error).message;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Tools of every connected server, first server wins on a name clash. */
  tools(): Tool[] {
    const seen = new Set<string>();
    const out: Tool[] = [];
    for (const e of this.entries.values()) {
      for (const t of e.tools) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        out.push(t);
      }
    }
    return out;
  }

  servers(): ServerState[] {
    return [...this.entries.values()].map(({ name, status, transport, error, tools, instructions }) => ({
      name, status, transport, error, tools, instructions,
    }));
  }

  async restart(name: string): Promise<ServerState> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`No MCP server named "${name}". Configured: ${[...this.entries.keys()].join(', ') || '(none)'}`);
    await e.connection?.client.close().catch(() => {});
    e.connection = undefined;
    if (e.config.disabled) {
      e.status = 'disabled';
      e.tools = [];
    } else await this.connect(e);
    return this.servers().find((s) => s.name === name)!;
  }

  /** Stop every server process. Call on exit: stdio children would otherwise keep Node alive. */
  async close(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.connection?.client.close().catch(() => {})));
    for (const e of this.entries.values()) e.connection = undefined;
  }
}

/** Builds the manager from settings (or returns undefined when no servers are configured). */
export function createMcpManager(servers: Record<string, McpServerConfig> | undefined, cwd: string, version: string): McpManager | undefined {
  if (!servers || Object.keys(servers).length === 0) return undefined;
  return new McpManager(servers, { cwd, connect: makeConnector(version) });
}
