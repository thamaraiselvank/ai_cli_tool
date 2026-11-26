import { spawn } from 'node:child_process';

/**
 * Runs one shell command the way the user's terminal would: PowerShell on Windows, sh elsewhere.
 * Shared by the Bash tool and hooks so both behave identically (encoding, timeouts, killing).
 */

const isWindows = process.platform === 'win32';

export interface ShellOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Written to the command's stdin, then stdin is closed (hooks receive their JSON this way). */
  input?: string;
  /** Extra environment variables on top of the current process's. */
  env?: Record<string, string>;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved in arrival order, as a terminal would show them. */
  combined: string;
  code: number | null;
  /** Why it didn't finish normally: 'timed out', 'interrupted by user', or 'failed to start: …'. */
  failure?: string;
}

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

export function shellCommand(command: string): [string, string[]] {
  if (!isWindows) return ['sh', ['-c', command]];
  // Force UTF-8 output; PowerShell 5.1 otherwise uses the legacy OEM code page.
  // The tail makes the exit code real: `powershell -Command` reports any failure as 1, so a
  // program's `exit 2` (which hooks rely on) would be lost. The command goes on its own line so a
  // trailing `# comment` in it can't swallow the tail.
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    command,
    '$__jarvisOk = $?; if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $__jarvisOk) { exit 1 }',
  ].join('\n');
  return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]];
}

export function runShell(command: string, o: ShellOptions): Promise<ShellResult> {
  return new Promise((resolve) => {
    const [shell, args] = shellCommand(command);
    const child = spawn(shell, args, {
      cwd: o.cwd,
      env: o.env ? { ...process.env, ...o.env } : process.env,
      detached: !isWindows,
      windowsHide: true,
      stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let combined = '';
    child.stdout!.on('data', (d) => {
      stdout += d;
      combined += d;
    });
    child.stderr!.on('data', (d) => {
      stderr += d;
      combined += d;
    });
    if (o.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {}); // the command may exit without reading stdin
      child.stdin.end(o.input);
    }

    let failure: string | undefined;
    const stop = (why: string) => {
      failure = why;
      if (child.pid) killTree(child.pid);
    };
    const timer = setTimeout(() => stop('timed out'), o.timeoutMs);
    const onAbort = () => stop('interrupted by user');
    o.signal?.addEventListener('abort', onAbort, { once: true });

    let done = false;
    const finish = (code: number | null, err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, combined, code, failure: err ? `failed to start: ${err.message}` : failure });
    };
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code));
  });
}
