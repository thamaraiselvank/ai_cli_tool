import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Tool } from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const isWindows = process.platform === 'win32';

const schema = z.object({
  command: z.string().min(1).describe('The command to run'),
  timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe('Default 120000'),
});

/** Kill the whole process tree: on Windows, killing the shell alone leaves its children running. */
function killTree(pid: number) {
  if (isWindows) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGKILL'); // negative pid = the process group (we spawn with detached: true)
    } catch {
      /* already exited */
    }
  }
}

export const BashTool: Tool<z.infer<typeof schema>> = {
  name: 'Bash',
  description: isWindows
    ? 'Run a shell command in the project directory (Windows PowerShell). Returns output and exit code.'
    : 'Run a shell command in the project directory (sh). Returns output and exit code.',
  schema,
  readOnly: false,
  loading: 'always',
  permissionKey: (a) => a.command,
  run(a, ctx) {
    return new Promise((resolve) => {
      const [shell, args] = isWindows
        ? // Force UTF-8 output; PowerShell 5.1 otherwise uses the legacy OEM code page.
          ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${a.command}`]]
        : ['sh', ['-c', a.command]];
      const child = spawn(shell, args as string[], {
        cwd: ctx.cwd,
        detached: !isWindows,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      child.stdout.on('data', (d) => (output += d));
      child.stderr.on('data', (d) => (output += d));

      let reason = '';
      const stop = (why: string) => {
        reason = why;
        if (child.pid) killTree(child.pid);
      };
      const timer = setTimeout(() => stop('timed out'), a.timeout_ms ?? DEFAULT_TIMEOUT_MS);
      const onAbort = () => stop('interrupted by user');
      ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });

      const finish = (code: number | null, err?: Error) => {
        clearTimeout(timer);
        ctx.abortSignal?.removeEventListener('abort', onAbort);
        const status = err ? `failed to start: ${err.message}` : reason || `exit code ${code}`;
        resolve(`${output.trimEnd() || '(no output)'}\n[${status}]`);
      };
      child.on('error', (err) => finish(null, err));
      child.on('close', (code) => finish(code));
    });
  },
};
