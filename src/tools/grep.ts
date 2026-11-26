import fs from 'node:fs/promises';
import { z } from 'zod';
import { displayPath, listFiles, looksBinary, resolvePath } from './fsutil.js';
import type { Tool } from './types.js';

const MAX_FILE_BYTES = 1_000_000;

const schema = z.object({
  pattern: z.string().describe('Regular expression to search for'),
  path: z.string().optional().describe('Directory to search in (default: project root)'),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. "**/*.ts"'),
  ignore_case: z.boolean().optional(),
  output_mode: z
    .enum(['files', 'content'])
    .optional()
    .describe('"files" (default): matching file paths. "content": matching lines as path:line:text'),
  max_results: z.number().int().min(1).optional().describe('Default 100'),
});

/**
 * Pure-JS grep: no ripgrep binary to download, works the same on every OS. Fine for typical repos;
 * can be swapped for @vscode/ripgrep later if speed on huge repos matters.
 */
export const GrepTool: Tool<z.infer<typeof schema>> = {
  name: 'Grep',
  description:
    'Search file contents with a regex. Use this to locate code, then Read only the relevant lines.',
  schema,
  readOnly: true,
  loading: 'always',
  permissionKey: (a) => a.pattern,
  paths: (a, cwd) => [resolvePath(cwd, a.path ?? '.')],
  async run(a, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(a.pattern, a.ignore_case ? 'i' : '');
    } catch (e) {
      throw new Error(`Invalid regex: ${(e as Error).message}`);
    }
    const root = resolvePath(ctx.cwd, a.path ?? '.');
    const mode = a.output_mode ?? 'files';
    const max = a.max_results ?? 100;
    const results: string[] = [];
    let truncated = false;

    const files = await listFiles(root, a.glob ?? '**/*');
    for (const file of files) {
      if (ctx.abortSignal?.aborted) break;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;
      const buf = await fs.readFile(file).catch(() => null);
      if (!buf || looksBinary(buf)) continue;

      const lines = buf.toString('utf8').split(/\r?\n/);
      const shown = displayPath(ctx.cwd, file);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i]!)) continue;
        if (results.length >= max) {
          truncated = true;
          break;
        }
        if (mode === 'files') {
          results.push(shown);
          break; // one entry per file
        }
        results.push(`${shown}:${i + 1}:${lines[i]!.slice(0, 300)}`);
      }
      if (truncated) break;
    }

    // Saying how many files were searched helps the model notice a wrong glob or path.
    if (results.length === 0) return `No matches (searched ${files.length} files).`;
    if (truncated) results.push(`… [stopped at ${max} results; narrow the pattern, path or glob]`);
    return results.join('\n');
  },
};
