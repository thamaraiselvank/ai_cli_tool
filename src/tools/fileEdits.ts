import fs from 'node:fs/promises';
import { createTwoFilesPatch } from 'diff';
import type { ToolContext } from './types.js';

export function recordFileState(ctx: ToolContext, file: string, mtimeMs: number) {
  ctx.fileState?.set(file, mtimeMs);
}

/** Throws unless the model has read `file` and it hasn't changed on disk since. */
export async function assertFresh(ctx: ToolContext, file: string, shown: string) {
  if (!ctx.fileState) return; // no tracking (e.g. unit tests calling a tool directly)
  const seen = ctx.fileState.get(file);
  if (seen === undefined) throw new Error(`Read ${shown} before modifying it.`);
  const { mtimeMs } = await fs.stat(file);
  if (mtimeMs !== seen) throw new Error(`${shown} changed since you last read it. Read it again first.`);
}

/**
 * Line endings: Read shows the model LF lines, so its old_string uses "\n". Files with CRLF
 * (common on Windows) would never match. We edit in LF and convert back, so the file keeps its style.
 */
export interface TextFile {
  text: string; // LF-normalized
  eol: '\n' | '\r\n';
}

export async function readText(file: string): Promise<TextFile> {
  const raw = await fs.readFile(file, 'utf8');
  return { text: raw.replace(/\r\n/g, '\n'), eol: raw.includes('\r\n') ? '\r\n' : '\n' };
}

export function toEol(text: string, eol: '\n' | '\r\n'): string {
  return eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text;
}

export const normalize = (s: string) => s.replace(/\r\n/g, '\n');

/** Exact string replacement with errors written for the model, so it can fix its next attempt. */
export function applyEdit(text: string, oldStr: string, newStr: string, replaceAll = false) {
  if (oldStr === '') throw new Error('old_string is empty. Use Write to create a file.');
  if (oldStr === newStr) throw new Error('old_string and new_string are identical; nothing to change.');
  const count = text.split(oldStr).length - 1;
  if (count === 0) {
    throw new Error(
      'old_string not found. Copy it exactly from the file (whitespace included, without the line-number prefix), or Read the file again.',
    );
  }
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_string appears ${count} times. Include more surrounding lines to make it unique, or set replace_all to true.`,
    );
  }
  // split/join instead of String.replace: replace() would interpret "$&" etc. in new_string.
  const result = replaceAll ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
  return { result, count: replaceAll ? count : 1 };
}

/** Unified diff body (no file headers), for the permission prompt. */
export function makeDiff(shown: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(shown, shown, before, after, undefined, undefined, { context: 3 });
  return patch
    .split('\n')
    .filter((l) => !/^(Index:|={5,}|--- |\+\+\+ )/.test(l) && l !== '\\ No newline at end of file')
    .join('\n')
    .trim();
}

/** A few numbered lines around `index` in `text`, so the model can verify an edit without re-reading. */
export function snippetAround(text: string, index: number, newStr: string, context = 3): string {
  const lines = text.split('\n');
  const startLine = text.slice(0, index).split('\n').length - 1;
  const endLine = startLine + newStr.split('\n').length - 1;
  const from = Math.max(0, startLine - context);
  const to = Math.min(lines.length, endLine + context + 1);
  const width = String(to).length;
  return lines
    .slice(from, to)
    .map((l, i) => `${String(from + i + 1).padStart(width)}\t${l}`)
    .join('\n');
}
