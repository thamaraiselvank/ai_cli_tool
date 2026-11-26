import { loadSettings, readSettingsFile, settingsPath, updateSettings, type McpServerConfig, type SettingsScope } from '../config/settings.js';
import { McpManager, makeConnector, transportKind, type ServerState } from '../mcp/client.js';
import { estimateToolTokens } from '../tools/registry.js';
import type { SlashCommand } from './types.js';

export const MCP_HELP = `Usage: mcp [list]                               connect to each server and show its tools
       mcp add <name> [options] -- <command> [args...]   add a local (stdio) server
       mcp add <name> --url <url> [--header "K: V"]      add a remote (HTTP) server
       mcp remove <name>                        remove a server
       mcp get <name>                           show a server's settings
Options: --env KEY=VALUE (repeatable; values may use \${VAR}), --sse (remote server uses SSE)
Scope: --global (all projects), --local (just you, gitignored). Default: project .jarvis/settings.json
Example: mcp add fs -- npx -y @modelcontextprotocol/server-filesystem .`;

const ICON: Record<ServerState['status'], string> = { connected: '●', connecting: '◌', failed: '✗', disabled: '○' };

export function formatServer(s: ServerState, verbose = false): string {
  const tokens = s.tools.reduce((n, t) => n + estimateToolTokens(t), 0);
  const head =
    s.status === 'connected'
      ? `${ICON[s.status]} ${s.name}  connected · ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'} (~${tokens} tokens) · ${s.transport}`
      : `${ICON[s.status]} ${s.name}  ${s.status}${s.error ? `: ${s.error.split('\n')[0]}` : ''} · ${s.transport}`;
  const lines = [head];
  if (verbose && s.error && s.error.includes('\n')) lines.push(...s.error.split('\n').slice(1).map((l) => `    ${l}`));
  if (verbose) lines.push(...s.tools.map((t) => `    ${t.name}${t.readOnly ? '  (read-only)' : ''}`));
  return lines.join('\n');
}

/** `/mcp` inside the chat: uses the live connections. */
export const mcpCommand: SlashCommand = {
  name: 'mcp',
  args: '[tools <name>|restart <name>]',
  description: 'MCP servers: status, their tools, reconnect',
  run: async (args, ctx) => {
    const mcp = ctx.mcp;
    if (!mcp || mcp.size === 0) {
      return ctx.print(`No MCP servers configured.\n\n${MCP_HELP.replace(/^Usage: /, 'In a terminal: jarvis ').replace(/\n {7}/g, '\n       jarvis ')}`);
    }
    const [sub, name] = args;
    if (sub === 'restart') {
      if (!name) return ctx.print('Give the server name, e.g. /mcp restart github', 'error');
      ctx.print(`Reconnecting ${name}…`);
      const s = await mcp.restart(name);
      return ctx.print(formatServer(s, true), s.status === 'failed' ? 'error' : 'info');
    }
    if (sub === 'tools') {
      const s = mcp.servers().find((x) => x.name === name);
      if (!s) return ctx.print(`No MCP server named "${name ?? ''}".`, 'error');
      return ctx.print(formatServer(s, true));
    }
    const rows = mcp.servers().map((s) => formatServer(s));
    ctx.print(
      [...rows, '', 'Tools are named mcp__<server>__<tool> and ask before running. Allow a whole server with /permissions allow mcp__<server>__*',
        'Changed settings? Restart Jarvis (or /mcp restart <name> after editing that server).'].join('\n'),
    );
  },
};

// ---- `jarvis mcp …` in the terminal --------------------------------------------------------------

function takeAll(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = args.indexOf(flag); i !== -1; i = args.indexOf(flag)) {
    const v = args[i + 1];
    if (v === undefined) throw new Error(`${flag} needs a value`);
    out.push(v);
    args.splice(i, 2);
  }
  return out;
}

export function parseAdd(argv: string[]): { name: string; config: McpServerConfig } {
  const dash = argv.indexOf('--');
  const before = dash === -1 ? [...argv] : argv.slice(0, dash);
  const command = dash === -1 ? [] : argv.slice(dash + 1);
  const env = takeAll(before, '--env');
  const headers = takeAll(before, '--header');
  const [url] = takeAll(before, '--url');
  const sse = before.includes('--sse');
  const [name, ...extra] = before.filter((a) => a !== '--sse');
  if (!name) throw new Error(`Give the server a name.\n${MCP_HELP}`);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Server names may only use letters, digits, - and _');
  if (extra.length) throw new Error(`Unexpected "${extra.join(' ')}". Put the server command after "--".`);

  const config: McpServerConfig = {};
  if (url) {
    if (command.length) throw new Error('Use either --url or a command after "--", not both.');
    config.url = url;
    if (sse) config.type = 'sse';
    if (headers.length) {
      config.headers = Object.fromEntries(
        headers.map((h) => {
          const i = h.indexOf(':');
          if (i < 1) throw new Error(`Bad header "${h}"; use "Name: value"`);
          return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
        }),
      );
    }
  } else {
    if (!command.length) throw new Error(`Give the command after "--", or --url for a remote server.\n${MCP_HELP}`);
    config.command = command[0];
    if (command.length > 1) config.args = command.slice(1);
  }
  if (env.length) {
    config.env = Object.fromEntries(
      env.map((kv) => {
        const i = kv.indexOf('=');
        if (i < 1) throw new Error(`Bad --env "${kv}"; use KEY=VALUE`);
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
  }
  return { name, config };
}

/** One implementation for `jarvis mcp …`. Returns text to print; throws on bad input. */
export async function runMcpCli(argv: string[], cwd: string, version: string): Promise<string> {
  const scope: SettingsScope = argv.includes('--global') ? 'global' : argv.includes('--local') ? 'local' : 'project';
  // Only strip scope flags before "--": after it they belong to the server's own command line.
  const dash = argv.indexOf('--');
  const head = (dash === -1 ? argv : argv.slice(0, dash)).filter((a) => a !== '--global' && a !== '--local');
  const args = dash === -1 ? head : [...head, ...argv.slice(dash)];
  const [sub = 'list', ...rest] = args;

  switch (sub) {
    case 'help':
    case '-h':
    case '--help':
      return MCP_HELP;
    case 'list': {
      const servers = loadSettings(cwd).mcpServers ?? {};
      if (!Object.keys(servers).length) return `No MCP servers configured.\n\n${MCP_HELP}`;
      const mcp = new McpManager(servers, { cwd, connect: makeConnector(version) });
      try {
        await mcp.start();
        return mcp.servers().map((s) => formatServer(s, true)).join('\n');
      } finally {
        await mcp.close();
      }
    }
    case 'get': {
      const [name] = rest;
      const cfg = name ? loadSettings(cwd).mcpServers?.[name] : undefined;
      if (!cfg) throw new Error(`No MCP server named "${name ?? ''}".`);
      return `${name} (${transportKind(cfg)})\n${JSON.stringify(cfg, null, 2)}`;
    }
    case 'add': {
      const { name, config } = parseAdd(rest);
      const file = updateSettings(scope, (s) => {
        s.mcpServers = { ...s.mcpServers, [name]: config };
      }, cwd);
      const secretHint = Object.values({ ...config.env, ...config.headers }).some((v) => !v.includes('${'))
        ? '\nTip: keep secrets out of settings files: use "${MY_TOKEN}" and set MY_TOKEN in your environment.'
        : '';
      return `Added MCP server "${name}" to ${file}. Check it with: jarvis mcp list${secretHint}`;
    }
    case 'remove': {
      const [name] = rest;
      if (!name) throw new Error('Give the server name.');
      const file = settingsPath(scope, cwd);
      if (!readSettingsFile(file).mcpServers?.[name]) {
        const where = (['global', 'project', 'local'] as const).filter((sc) => readSettingsFile(settingsPath(sc, cwd)).mcpServers?.[name]);
        if (!where.length) throw new Error(`No MCP server named "${name}".`);
        const how = where[0] === 'project' ? 'no scope flag' : `--${where[0]}`;
        throw new Error(`"${name}" is not in ${file}. It is in the ${where.join(' and ')} settings; use ${how} to remove it there.`);
      }
      updateSettings(scope, (s) => {
        const { [name]: _gone, ...others } = s.mcpServers ?? {};
        s.mcpServers = others;
      }, cwd);
      return `Removed MCP server "${name}" from ${file}.`;
    }
    default:
      throw new Error(`Unknown subcommand "${sub}".\n${MCP_HELP}`);
  }
}
