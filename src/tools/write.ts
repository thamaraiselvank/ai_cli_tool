import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { assertFresh, makeDiff, normalize, readText, recordFileState, toEol } from './fileEdits.js';
import { displayPath, resolvePath } from './fsutil.js';
import type { Tool, ToolContext } from './types.js';

const schema = z.object({
  file_path: z.string().describe('File to create or overwrite'),
  content: z.string().describe('Full file content'),
});
type Args = z.infer<typeof schema>;

async function plan(a: Args, ctx: ToolContext) {
  const file = resolvePath(ctx.cwd, a.file_path);
  const shown = displayPath(ctx.cwd, file);
  const stat = await fs.stat(file).catch(() => null);
  if (stat?.isDirectory()) throw new Error(`${shown} is a directory.`);
  let before = '';
  let eol: '\n' | '\r\n' = '\n';
  if (stat) {
    // Overwriting is allowed only after reading, same rule as Edit.
    await assertFresh(ctx, file, shown);
    ({ text: before, eol } = await readText(file));
  }
  return { file, shown, exists: Boolean(stat), before, eol, after: normalize(a.content) };
}

export const WriteTool: Tool<Args> = {
  name: 'Write',
  description:
    'Create a new file or fully overwrite one. For changes to an existing file prefer Edit; overwriting requires reading the file first.',
  schema,
  readOnly: false,
  loading: 'always',
  permissionKey: (a) => a.file_path,
  paths: (a, cwd) => [resolvePath(cwd, a.file_path)],
  async preview(a, ctx) {
    const p = await plan(a, ctx);
    return makeDiff(p.shown, p.before, p.after);
  },
  async run(a, ctx) {
    const p = await plan(a, ctx);
    await fs.mkdir(path.dirname(p.file), { recursive: true });
    // Existing files keep their line-ending style. New files get LF on every OS: git and all
    // editors handle it, and it keeps diffs stable across platforms.
    await fs.writeFile(p.file, toEol(p.after, p.eol), 'utf8');
    recordFileState(ctx, p.file, (await fs.stat(p.file)).mtimeMs);
    const lines = p.after === '' ? 0 : p.after.replace(/\n$/, '').split('\n').length;
    return `${p.exists ? 'Overwrote' : 'Created'} ${p.shown} (${lines} lines).`;
  },
};
