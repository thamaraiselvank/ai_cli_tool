import fs from 'node:fs/promises';
import { z } from 'zod';
import { recordFileState } from './fileEdits.js';
import { looksBinary, resolvePath } from './fsutil.js';
import type { Tool } from './types.js';

const MAX_LINE_CHARS = 2000;
const DEFAULT_LIMIT = 2000;

const schema = z.object({
  file_path: z.string().describe('File path, absolute or relative to the project'),
  offset: z.number().int().min(1).optional().describe('First line to read (1-based)'),
  limit: z.number().int().min(1).optional().describe('Number of lines to read'),
});

export const ReadTool: Tool<z.infer<typeof schema>> = {
  name: 'Read',
  description:
    'Read a text file. Returns lines prefixed with line numbers. For large files, pass offset/limit to read only the part you need.',
  schema,
  readOnly: true,
  loading: 'always',
  permissionKey: (a) => a.file_path,
  paths: (a, cwd) => [resolvePath(cwd, a.file_path)],
  async run(a, ctx) {
    const file = resolvePath(ctx.cwd, a.file_path);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) throw new Error(`File not found: ${a.file_path}`);
    if (stat.isDirectory()) throw new Error(`${a.file_path} is a directory. Use Glob to list files.`);
    const buf = await fs.readFile(file);
    if (looksBinary(buf)) throw new Error(`${a.file_path} looks like a binary file.`);
    recordFileState(ctx, file, stat.mtimeMs); // unlocks Edit/Write for this file

    const lines = buf.toString('utf8').split(/\r?\n/);
    const start = (a.offset ?? 1) - 1;
    const end = Math.min(lines.length, start + (a.limit ?? DEFAULT_LIMIT));
    if (start >= lines.length) return `(file has only ${lines.length} lines)`;

    // "  12\tcode" format: line numbers let the model cite and later Edit precise locations.
    const width = String(end).length;
    const out = lines.slice(start, end).map((line, i) => {
      const text = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '… [line cut]' : line;
      return `${String(start + i + 1).padStart(width)}\t${text}`;
    });
    if (end < lines.length) out.push(`… [${lines.length - end} more lines; use offset=${end + 1}]`);
    return out.join('\n');
  },
};
