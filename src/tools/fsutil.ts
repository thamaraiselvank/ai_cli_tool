import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import ignore from 'ignore';

/** Always skipped, even without a .gitignore: huge and never what the model is looking for. */
export const DEFAULT_IGNORES = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**'];

export function resolvePath(cwd: string, p: string): string {
  return path.resolve(cwd, p);
}

export function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Paths shown to the model are relative to cwd with forward slashes: shorter, and stable across OSes. */
export function displayPath(cwd: string, p: string): string {
  const rel = path.relative(cwd, p);
  return (rel.startsWith('..') || path.isAbsolute(rel) ? p : rel).split(path.sep).join('/');
}

function gitignoreFilter(root: string) {
  const ig = ignore();
  const file = path.join(root, '.gitignore');
  if (fs.existsSync(file)) ig.add(fs.readFileSync(file, 'utf8'));
  return ig;
}

/** Files under `root` matching `pattern`, honoring the root .gitignore. Newest first. */
export async function listFiles(root: string, pattern = '**/*'): Promise<string[]> {
  const ig = gitignoreFilter(root);
  const entries = await fg(pattern, {
    cwd: root,
    ignore: DEFAULT_IGNORES,
    dot: true,
    onlyFiles: true,
    stats: true,
    suppressErrors: true,
  });
  return entries
    .filter((e) => !ig.ignores(e.path))
    .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
    .map((e) => path.join(root, e.path));
}

/** Cheap binary check: a NUL byte in the first 8 KB. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}
