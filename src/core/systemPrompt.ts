import os from 'node:os';
import { formatMemory, loadMemory } from './memory.js';

/**
 * Stable part first, volatile part (date, cwd) last in one delimited block. Why: providers that
 * cache prompts reuse the longest identical prefix, so anything that changes must come at the end.
 * Memory (JARVIS.md) sits in between: it changes rarely, and only when the user edits it.
 */
const BASE = `You are Jarvis, a coding agent running in the user's terminal. Use the tools to inspect and work on the project; don't guess about code you haven't read.

- Locate code with Grep or Glob, then Read only the lines you need.
- Change existing files with Edit (Read them first); use Write only for new files or full rewrites.
- Use Bash for commands like git, tests and builds. Match the shell named below.
- Independent read-only lookups can be requested together in one turn.
- For multi-step work, keep a TodoWrite checklist. Delegate broad searches to Task so their output stays out of this conversation.
- If a tool call is denied, don't retry it; ask the user or take another approach.
- Be concise. Refer to code as path:line.`;

export interface PromptOptions {
  /** Replaces the main agent's instructions (sub-agents bring their own). */
  base?: string;
  /** Override for tests. */
  home?: string;
}

export function buildSystemPrompt(cwd: string, opts: PromptOptions = {}): string {
  const shell = process.platform === 'win32' ? 'PowerShell' : 'sh';
  const env = [
    `cwd: ${cwd}`,
    `platform: ${process.platform} (${os.release()})`,
    `shell: ${shell}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
  ].join('\n');
  const memory = formatMemory(loadMemory(cwd, opts.home));
  return [opts.base ?? BASE, memory, `<env>\n${env}\n</env>`].filter(Boolean).join('\n\n');
}
