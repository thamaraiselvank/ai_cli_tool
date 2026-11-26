import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * One MCP server. Either a local process (`command`, spoken to over stdin/stdout) or a remote
 * one (`url`). Strings may use ${VAR} / ${VAR:-default}, so secrets stay in env vars, not here.
 */
export interface McpServerConfig {
  /** stdio: the program to start, e.g. "npx". */
  command?: string;
  args?: string[];
  /** Extra env vars for the process. Only a safe default set (PATH, HOME, …) is inherited. */
  env?: Record<string, string>;
  /** Working directory for the process (default: the project). */
  cwd?: string;
  /** Remote server endpoint. */
  url?: string;
  /** 'http' (streamable HTTP, default for url) or the older 'sse'. */
  type?: 'stdio' | 'http' | 'sse';
  /** e.g. { "Authorization": "Bearer ${GITHUB_TOKEN}" } */
  headers?: Record<string, string>;
  /** Keep the entry but don't start it. */
  disabled?: boolean;
  /** Per-call timeout in seconds (default 120). */
  timeout?: number;
}

export interface Settings {
  model?: string;
  /** MCP servers whose tools are offered to the model as mcp__<server>__<tool>. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Tried in order when the main model is rate-limited, down, or misconfigured. */
  fallbacks?: string[];
  /** Per-provider overrides or new providers: { "groq": { "rpm": 30, "tpm": 6000 } } */
  providers?: Record<string, { baseURL?: string; apiKeyEnv?: string; rpm?: number; tpm?: number }>;
  retry?: {
    /** Retries per model before falling back (default 3). */
    maxRetries?: number;
    /** Longest single wait we accept; a longer server-requested wait triggers fallback (default 30). */
    maxWaitSeconds?: number;
  };
  tools?: {
    /** Tool names that are never sent to the model. */
    disabled?: string[];
    /** Per-tool description overrides: { "Bash": "Run PowerShell. Never use rm." } */
    descriptions?: Record<string, string>;
  };
  permissions?: {
    /** e.g. "Read", "Bash(git status)", "Bash(npm test:*)" */
    allow?: string[];
    /** Deny beats allow. e.g. "Read(.env)", "Bash(rm:*)" */
    deny?: string[];
  };
  agents?: {
    /** Default model for sub-agents (e.g. a fast free one); an agent file's `model` wins. */
    model?: string;
    /** Step limit per sub-agent run (default 30). */
    maxSteps?: number;
  };
  context?: {
    maxToolOutputLines?: number;
    maxToolOutputBytes?: number;
    /** Fraction of the context limit at which old tool outputs are cleared (default 0.5). */
    clearToolOutputAt?: number;
    /** Fraction at which older messages are summarized (default 0.75). */
    compactAt?: number;
    /** How many recent tool results always stay intact (default 4). */
    keepToolResults?: number;
    /** Per-model context window overrides, e.g. { "ollama/qwen2.5-coder:7b": 32768 }. */
    windows?: Record<string, number>;
    /** Window to assume when a provider doesn't report one (default 32768). */
    defaultWindow?: number;
  };
}

export type SettingsScope = 'global' | 'project' | 'local';

export function settingsPath(scope: SettingsScope, cwd = process.cwd()): string {
  if (scope === 'global') return path.join(os.homedir(), '.jarvis', 'settings.json');
  return path.join(cwd, '.jarvis', scope === 'local' ? 'settings.local.json' : 'settings.json');
}

/** Merge order: global → project → local. Objects merge deeply, arrays are unioned, scalars override. */
export function settingsPaths(cwd = process.cwd()): string[] {
  return (['global', 'project', 'local'] as const).map((s) => settingsPath(s, cwd));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function mergeSettings(base: any, over: any): any {
  if (Array.isArray(base) && Array.isArray(over)) return [...new Set([...base, ...over])];
  if (isObject(base) && isObject(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) {
      // A server defined again in a more specific file replaces the earlier definition as a whole;
      // a deep merge would union their `args` arrays into a broken command line.
      if (k === 'mcpServers' && isObject(base[k]) && isObject(v)) out[k] = { ...base[k], ...v };
      else out[k] = k in base ? mergeSettings(base[k], v) : v;
    }
    return out;
  }
  return over;
}

export function readSettingsFile(file: string): Settings {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Settings;
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${(e as Error).message}`);
  }
}

export function loadSettings(cwd = process.cwd()): Settings {
  return settingsPaths(cwd).reduce<Settings>((acc, f) => mergeSettings(acc, readSettingsFile(f)), {});
}

/** Read-modify-write one settings file (creating it if needed). */
export function updateSettings(scope: SettingsScope, mutate: (s: Settings) => void, cwd = process.cwd()): string {
  const file = settingsPath(scope, cwd);
  const s = readSettingsFile(file);
  mutate(s);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  return file;
}
