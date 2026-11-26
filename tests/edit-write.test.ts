import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEdit } from '../src/tools/fileEdits.js';
import { EditTool } from '../src/tools/edit.js';
import { ReadTool } from '../src/tools/read.js';
import type { ToolContext } from '../src/tools/types.js';
import { WriteTool } from '../src/tools/write.js';

let cwd: string;
let ctx: ToolContext;
const file = () => path.join(cwd, 'a.txt');

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-edit-'));
  ctx = { cwd, fileState: new Map() };
  fs.writeFileSync(file(), 'one\ntwo\nthree\ntwo\n');
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

describe('applyEdit', () => {
  it('replaces a unique match and treats $ literally', () => {
    expect(applyEdit('a b c', 'b', '$&!').result).toBe('a $&! c');
  });
  it('explains missing, ambiguous and no-op edits', () => {
    expect(() => applyEdit('abc', 'x', 'y')).toThrow(/not found/);
    expect(() => applyEdit('x x', 'x', 'y')).toThrow(/appears 2 times/);
    expect(() => applyEdit('x', 'x', 'x')).toThrow(/identical/);
  });
  it('replaces all when asked', () => {
    expect(applyEdit('x x', 'x', 'y', true)).toEqual({ result: 'y y', count: 2 });
  });
});

describe('Edit', () => {
  it('requires reading the file first', async () => {
    await expect(EditTool.run({ file_path: 'a.txt', old_string: 'one', new_string: '1' }, ctx)).rejects.toThrow(/Read a\.txt/);
  });

  it('edits after Read, returns a numbered snippet, and allows a follow-up edit', async () => {
    await ReadTool.run({ file_path: 'a.txt' }, ctx);
    const out = await EditTool.run({ file_path: 'a.txt', old_string: 'three', new_string: '3' }, ctx);
    expect(out).toContain('Edited a.txt (1 replacement)');
    expect(out).toContain('3\t3');
    // Our own write updated the recorded state, so no re-read is needed for a second edit.
    await EditTool.run({ file_path: 'a.txt', old_string: 'one', new_string: '1' }, ctx);
    expect(fs.readFileSync(file(), 'utf8')).toBe('1\ntwo\n3\ntwo\n');
  });

  it('refuses when the file changed on disk after reading', async () => {
    await ReadTool.run({ file_path: 'a.txt' }, ctx);
    fs.writeFileSync(file(), 'changed elsewhere\n');
    fs.utimesSync(file(), new Date(), new Date(Date.now() + 5000)); // make sure mtime differs
    await expect(EditTool.run({ file_path: 'a.txt', old_string: 'changed', new_string: 'x' }, ctx)).rejects.toThrow(/changed since/);
  });

  it('matches LF text against CRLF files and keeps CRLF', async () => {
    fs.writeFileSync(file(), 'a\r\nb\r\nc\r\n');
    await ReadTool.run({ file_path: 'a.txt' }, ctx);
    await EditTool.run({ file_path: 'a.txt', old_string: 'a\nb', new_string: 'a\nB' }, ctx);
    expect(fs.readFileSync(file(), 'utf8')).toBe('a\r\nB\r\nc\r\n');
  });

  it('previews a diff without touching the file', async () => {
    await ReadTool.run({ file_path: 'a.txt' }, ctx);
    const diff = await EditTool.preview!({ file_path: 'a.txt', old_string: 'one', new_string: 'ONE' }, ctx);
    expect(diff).toContain('-one');
    expect(diff).toContain('+ONE');
    expect(fs.readFileSync(file(), 'utf8')).toContain('one');
  });
});

describe('Write', () => {
  it('creates new files (and folders) without a prior Read', async () => {
    const out = await WriteTool.run({ file_path: 'src/new.ts', content: 'x\ny\n' }, ctx);
    expect(out).toContain('Created src/new.ts');
    expect(fs.readFileSync(path.join(cwd, 'src', 'new.ts'), 'utf8')).toBe('x\ny\n');
  });
  it('requires a Read before overwriting', async () => {
    await expect(WriteTool.run({ file_path: 'a.txt', content: 'new' }, ctx)).rejects.toThrow(/Read a\.txt/);
    await ReadTool.run({ file_path: 'a.txt' }, ctx);
    expect(await WriteTool.run({ file_path: 'a.txt', content: 'new' }, ctx)).toContain('Overwrote');
  });
});
