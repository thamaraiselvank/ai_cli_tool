import { z } from 'zod';
import { displayPath, listFiles, resolvePath } from './fsutil.js';
import type { Tool } from './types.js';

const MAX_RESULTS = 200;

const schema = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts" or "**/package.json"'),
  path: z.string().optional().describe('Directory to search in (default: project root)'),
});

export const GlobTool: Tool<z.infer<typeof schema>> = {
  name: 'Glob',
  description: 'Find files by name pattern. Returns matching paths, most recently modified first.',
  schema,
  readOnly: true,
  loading: 'always',
  permissionKey: (a) => a.pattern,
  paths: (a, cwd) => [resolvePath(cwd, a.path ?? '.')],
  async run(a, ctx) {
    const root = resolvePath(ctx.cwd, a.path ?? '.');
    const files = await listFiles(root, a.pattern);
    if (files.length === 0) return 'No files found.';
    const shown = files.slice(0, MAX_RESULTS).map((f) => displayPath(ctx.cwd, f));
    if (files.length > MAX_RESULTS) {
      shown.push(`… [${files.length - MAX_RESULTS} more; use a more specific pattern]`);
    }
    return shown.join('\n');
  },
};
