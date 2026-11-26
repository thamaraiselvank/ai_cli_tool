import { z } from 'zod';
import { runShell } from './shell.js';
import type { Tool } from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const isWindows = process.platform === 'win32';

const schema = z.object({
  command: z.string().min(1).describe('The command to run'),
  timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe('Default 120000'),
});

export const BashTool: Tool<z.infer<typeof schema>> = {
  name: 'Bash',
  description: isWindows
    ? 'Run a shell command in the project directory (Windows PowerShell). Returns output and exit code.'
    : 'Run a shell command in the project directory (sh). Returns output and exit code.',
  schema,
  readOnly: false,
  loading: 'always',
  permissionKey: (a) => a.command,
  async run(a, ctx) {
    const r = await runShell(a.command, { cwd: ctx.cwd, timeoutMs: a.timeout_ms ?? DEFAULT_TIMEOUT_MS, signal: ctx.abortSignal });
    return `${r.combined.trimEnd() || '(no output)'}\n[${r.failure ?? `exit code ${r.code}`}]`;
  },
};
