import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Project memory: JARVIS.md files whose contents go into the system prompt, so conventions
 * ("use pnpm", "tests live in tests/", "never touch generated/") don't have to be repeated
 * every session.
 *
 * Sources, general → specific (later ones win when they conflict, so they come last):
 *   ~/.jarvis/JARVIS.md          personal, every project
 *   <repo root>/…/<cwd>/JARVIS.md   each folder from the git root down to cwd (monorepo-friendly)
 *   <cwd>/JARVIS.local.md        personal notes for this project (gitignore it)
 */

export const MEMORY_FILE = 'JARVIS.md';
/** Per file. Memory is paid for on every request, so a runaway file must not eat the context. */
export const MAX_MEMORY_CHARS = 20_000;

export interface MemoryFile {
  path: string;
  content: string;
  truncated: boolean;
}

/** The git root above cwd, or undefined outside a repo. */
function gitRoot(cwd: string): string | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

export function memoryPaths(cwd: string, home = os.homedir()): string[] {
  const here = path.resolve(cwd);
  const root = gitRoot(here) ?? here;
  // Folders root → cwd. Outside a repo that's just cwd: we don't want ~/JARVIS.md by accident.
  const dirs: string[] = [];
  for (let d = here; ; d = path.dirname(d)) {
    dirs.unshift(d);
    if (d === root || path.dirname(d) === d) break;
  }
  return [
    path.join(home, '.jarvis', MEMORY_FILE),
    ...dirs.map((d) => path.join(d, MEMORY_FILE)),
    path.join(here, 'JARVIS.local.md'),
  ];
}

export function loadMemory(cwd: string, home?: string): MemoryFile[] {
  const out: MemoryFile[] = [];
  for (const p of new Set(memoryPaths(cwd, home))) {
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf8').trim();
    } catch {
      continue;
    }
    if (!text) continue;
    const truncated = text.length > MAX_MEMORY_CHARS;
    out.push({ path: p, content: truncated ? text.slice(0, MAX_MEMORY_CHARS) : text, truncated });
  }
  return out;
}

/** The block inserted into the system prompt, or '' when there is no memory. */
export function formatMemory(files: MemoryFile[]): string {
  if (files.length === 0) return '';
  const parts = files.map((f) => {
    const note = f.truncated ? `\n[… truncated at ${MAX_MEMORY_CHARS} characters]` : '';
    return `<memory path="${f.path}">\n${f.content}${note}\n</memory>`;
  });
  return `# Memory\nInstructions from JARVIS.md files. Follow them; later files are more specific and win on conflicts.\n\n${parts.join('\n\n')}`;
}

/** `/memory add`: append a bullet to the project's JARVIS.md, creating it if needed. */
export function appendMemory(cwd: string, note: string): string {
  const file = path.join(cwd, MEMORY_FILE);
  const exists = fs.existsSync(file);
  const prefix = exists ? (fs.readFileSync(file, 'utf8').endsWith('\n') ? '' : '\n') : '# Project notes for Jarvis\n\n';
  fs.appendFileSync(file, `${prefix}- ${note.trim()}\n`);
  return file;
}
