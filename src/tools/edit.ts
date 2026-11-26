import fs from 'node:fs/promises';
import { z } from 'zod';
import { applyEdit, assertFresh, makeDiff, normalize, readText, recordFileState, snippetAround, toEol } from './fileEdits.js';
import { displayPath, resolvePath } from './fsutil.js';
import type { Tool, ToolContext } from './types.js';

const schema = z.object({
  file_path: z.string().describe('File to edit'),
  old_string: z.string().describe('Exact text to replace; must be unique in the file unless replace_all'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z.boolean().optional().describe('Replace every occurrence'),
});
type Args = z.infer<typeof schema>;

/** Shared by preview (dry run for the prompt) and run (the real thing), so both always agree. */
async function plan(a: Args, ctx: ToolContext) {
  const file = resolvePath(ctx.cwd, a.file_path);
  const shown = displayPath(ctx.cwd, file);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) throw new Error(`File not found: ${shown}. Use Write to create it.`);
  await assertFresh(ctx, file, shown);
  const { text, eol } = await readText(file);
  const oldStr = normalize(a.old_string);
  const newStr = normalize(a.new_string);
  const { result, count } = applyEdit(text, oldStr, newStr, a.replace_all);
  return { file, shown, text, eol, result, count, oldStr, newStr };
}

/**
 * Exact string replacement rather than line numbers or full rewrites. Why: the model only sends the
 * changed part (cheap in tokens), and "must match exactly once" catches most wrong-location edits.
 */
export const EditTool: Tool<Args> = {
  name: 'Edit',
  description:
    'Replace exact text in a file. Read the file first. old_string must match exactly once (copy it without line-number prefixes); include surrounding lines if needed.',
  schema,
  readOnly: false,
  loading: 'always',
  permissionKey: (a) => a.file_path,
  paths: (a, cwd) => [resolvePath(cwd, a.file_path)],
  async preview(a, ctx) {
    const p = await plan(a, ctx);
    return makeDiff(p.shown, p.text, p.result);
  },
  async run(a, ctx) {
    const p = await plan(a, ctx);
    await fs.writeFile(p.file, toEol(p.result, p.eol), 'utf8');
    recordFileState(ctx, p.file, (await fs.stat(p.file)).mtimeMs);
    const head = `Edited ${p.shown} (${p.count} replacement${p.count > 1 ? 's' : ''}).`;
    if (p.count > 1) return head;
    const at = p.text.indexOf(p.oldStr);
    return `${head}\n${snippetAround(p.result, at, p.newStr)}`;
  },
};
