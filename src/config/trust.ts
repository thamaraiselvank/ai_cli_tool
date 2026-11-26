import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeSettings, readSettingsFile, type McpServerConfig, type Settings } from './settings.js';

/**
 * Folder trust. Hooks and MCP servers *run commands by themselves*. A cloned repo can ship a
 * `.jarvis/settings.json` (or even a committed settings.local.json — .gitignore doesn't stop that),
 * so without this, `git clone evil && cd evil && jarvis` would execute the repo's commands.
 *
 * Rule: command-running settings (hooks, mcpServers) from a folder's own `.jarvis/` files are used
 * only after the user trusts that folder once. The global file (~/.jarvis) is always the user's own.
 * Trusted folders are stored in ~/.jarvis/trusted-projects.json.
 */

export interface SettingsSource {
  scope: 'global' | 'project' | 'local';
  file: string;
  trusted: boolean;
}

function trustFile(home: string): string {
  return path.join(home, '.jarvis', 'trusted-projects.json');
}

/** Case-insensitive on Windows, where F:\x and f:\X are the same folder. */
function norm(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function readTrusted(home: string): string[] {
  try {
    const data = JSON.parse(fs.readFileSync(trustFile(home), 'utf8')) as { projects?: unknown };
    return Array.isArray(data.projects) ? data.projects.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export function isTrusted(cwd: string, home = os.homedir()): boolean {
  const here = norm(cwd);
  // Trusting a folder also trusts its subfolders (e.g. packages in a monorepo).
  return readTrusted(home).some((p) => {
    const t = norm(p);
    return here === t || here.startsWith(t.endsWith(path.sep) ? t : t + path.sep);
  });
}

export function trustProject(cwd: string, home = os.homedir()): string {
  const file = trustFile(home);
  const list = readTrusted(home);
  if (!isTrusted(cwd, home)) list.push(path.resolve(cwd));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ projects: list }, null, 2) + '\n');
  return file;
}

export function settingsSources(cwd: string, home = os.homedir()): SettingsSource[] {
  const trusted = isTrusted(cwd, home);
  return [
    { scope: 'global', file: path.join(home, '.jarvis', 'settings.json'), trusted: true },
    { scope: 'project', file: path.join(cwd, '.jarvis', 'settings.json'), trusted },
    { scope: 'local', file: path.join(cwd, '.jarvis', 'settings.local.json'), trusted },
  ];
}

/** What an untrusted folder wants to run, so we can tell the user instead of silently ignoring it. */
export function untrustedCommands(cwd: string, home = os.homedir()): { hooks: number; mcpServers: string[] } {
  let hooks = 0;
  const mcpServers: string[] = [];
  for (const s of settingsSources(cwd, home).filter((x) => !x.trusted)) {
    const data = safeRead(s.file);
    for (const list of Object.values(data.hooks ?? {})) hooks += Array.isArray(list) ? list.length : 0;
    mcpServers.push(...Object.keys(data.mcpServers ?? {}));
  }
  return { hooks, mcpServers: [...new Set(mcpServers)] };
}

function safeRead(file: string): Settings {
  try {
    return readSettingsFile(file);
  } catch {
    return {};
  }
}

/**
 * For commands where the user adds a command-running setting to this folder themselves
 * (`/permissions allow`, `jarvis mcp add`). Call it *before* writing: if the folder holds nothing
 * else that trusting would switch on, we trust it (their own action is consent). If it does, we
 * don't, because that would silently enable the repo's own hooks/servers; we say so instead.
 * Returns a note for the user ('' when already trusted).
 */
export function autoTrust(cwd: string, what: string, home = os.homedir()): () => string {
  if (isTrusted(cwd, home)) return () => '';
  const pending = untrustedCommands(cwd, home);
  const parts = [
    pending.hooks ? `${pending.hooks} hook(s)` : '',
    pending.mcpServers.length ? `MCP server(s) ${pending.mcpServers.join(', ')}` : '',
  ].filter(Boolean);
  return () => {
    if (!parts.length) {
      trustProject(cwd, home);
      return `\nTrusted this folder so ${what} take effect.`;
    }
    return `\nNote: this folder isn't trusted, so ${what} are ignored here. It also defines ${parts.join(' and ')}; review .jarvis/ and run /trust to enable everything.`;
  };
}

/** mcpServers from trusted sources only, merged the usual way (later files win per server). */
export function trustedMcpServers(cwd: string, home = os.homedir()): Record<string, McpServerConfig> {
  return settingsSources(cwd, home)
    .filter((s) => s.trusted)
    .reduce<Settings>((acc, s) => mergeSettings(acc, { mcpServers: safeRead(s.file).mcpServers ?? {} }), {}).mcpServers ?? {};
}
