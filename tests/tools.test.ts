import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BashTool } from '../src/tools/bash.js';
import { GlobTool } from '../src/tools/glob.js';
import { GrepTool } from '../src/tools/grep.js';
import { ReadTool } from '../src/tools/read.js';

let cwd: string;

beforeAll(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tools-'));
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.mkdirSync(path.join(cwd, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'const alpha = 1;\nconst beta = 2;\nexport { alpha, beta };\n');
  fs.writeFileSync(path.join(cwd, 'src', 'b.md'), '# Beta notes\n');
  fs.writeFileSync(path.join(cwd, 'secret.log'), 'beta in an ignored file\n');
  fs.writeFileSync(path.join(cwd, 'node_modules', 'dep', 'index.ts'), 'const beta = 3;\n');
  fs.writeFileSync(path.join(cwd, 'bin.dat'), Buffer.from([1, 0, 2, 0]));
  fs.writeFileSync(path.join(cwd, '.gitignore'), '*.log\n');
});
afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

describe('Read', () => {
  it('numbers lines and honors offset/limit', async () => {
    const out = await ReadTool.run({ file_path: 'src/a.ts', offset: 2, limit: 1 }, { cwd });
    expect(out).toContain('2\tconst beta = 2;');
    expect(out).not.toContain('alpha = 1');
    expect(out).toContain('use offset=3');
  });
  it('rejects missing files, directories and binaries', async () => {
    await expect(ReadTool.run({ file_path: 'nope.ts' }, { cwd })).rejects.toThrow(/not found/);
    await expect(ReadTool.run({ file_path: 'src' }, { cwd })).rejects.toThrow(/directory/);
    await expect(ReadTool.run({ file_path: 'bin.dat' }, { cwd })).rejects.toThrow(/binary/);
  });
});

describe('Glob', () => {
  it('finds files and skips node_modules + .gitignore entries', async () => {
    const out = await GlobTool.run({ pattern: '**/*' }, { cwd });
    expect(out).toContain('src/a.ts');
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('secret.log');
  });
});

describe('Grep', () => {
  it('lists matching files by default', async () => {
    const out = await GrepTool.run({ pattern: 'beta', ignore_case: true }, { cwd });
    expect(out.split('\n').sort()).toEqual(['src/a.ts', 'src/b.md']);
  });
  it('shows path:line:text in content mode and filters by glob', async () => {
    const out = await GrepTool.run({ pattern: 'beta', output_mode: 'content', glob: '**/*.ts' }, { cwd });
    expect(out).toContain('src/a.ts:2:const beta = 2;');
    expect(out).not.toContain('b.md');
  });
  it('reports how many files it searched when nothing matches', async () => {
    expect(await GrepTool.run({ pattern: 'zzz' }, { cwd })).toMatch(/No matches \(searched \d+ files\)/);
  });
  it('turns a bad regex into an error', async () => {
    await expect(GrepTool.run({ pattern: '(' }, { cwd })).rejects.toThrow(/Invalid regex/);
  });
});

describe('Bash', () => {
  it('returns output and exit code', async () => {
    const out = await BashTool.run({ command: 'echo hello' }, { cwd });
    expect(out).toContain('hello');
    expect(out).toContain('[exit code 0]');
  });
  it('reports a non-zero exit code', async () => {
    expect(await BashTool.run({ command: 'exit 3' }, { cwd })).toContain('[exit code 3]');
  });
  it('kills commands that exceed the timeout', async () => {
    const cmd = process.platform === 'win32' ? 'Start-Sleep -Seconds 20' : 'sleep 20';
    expect(await BashTool.run({ command: cmd, timeout_ms: 1500 }, { cwd })).toContain('[timed out]');
  }, 15_000);
});
