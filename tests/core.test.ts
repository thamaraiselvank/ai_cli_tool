import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeSettings } from '../src/config/settings.js';
import { capOutput } from '../src/core/truncate.js';
import { checkPermission, ruleMatches } from '../src/permissions/index.js';
import { BashTool } from '../src/tools/bash.js';
import { ReadTool } from '../src/tools/read.js';
import { activeTools, toolStatuses } from '../src/tools/registry.js';

describe('capOutput', () => {
  it('leaves short output alone', () => {
    expect(capOutput('a\nb', { maxLines: 10, maxBytes: 1000 })).toBe('a\nb');
  });
  it('cuts by lines and says so', () => {
    const out = capOutput('1\n2\n3\n4\n5', { maxLines: 2, maxBytes: 1000 });
    expect(out.startsWith('1\n2\n')).toBe(true);
    expect(out).toContain('truncated');
  });
  it('cuts by bytes', () => {
    const out = capOutput('x'.repeat(50) + '\n' + 'y'.repeat(50), { maxLines: 100, maxBytes: 60 });
    expect(out).not.toContain('y');
    expect(out).toContain('truncated');
  });
});

describe('permission rules', () => {
  it('matches exact and prefix rules', () => {
    expect(ruleMatches('Bash(git status)', 'Bash', 'git status')).toBe(true);
    expect(ruleMatches('Bash(git status)', 'Bash', 'git status -s')).toBe(false);
    expect(ruleMatches('Bash(npm test:*)', 'Bash', 'npm test -- --watch')).toBe(true);
    expect(ruleMatches('Bash', 'Bash', 'anything')).toBe(true);
    expect(ruleMatches('Read', 'Bash', 'x')).toBe(false);
  });

  const cwd = path.resolve('/project');
  const base = { cwd, sessionAllow: [] as string[] };

  it('allows read-only tools inside the project, asks outside', () => {
    expect(checkPermission(ReadTool, { file_path: 'a.ts' }, { ...base, settings: {} })).toBe('allow');
    expect(checkPermission(ReadTool, { file_path: '../other/a.ts' }, { ...base, settings: {} })).toBe('ask');
  });
  it('asks for Bash by default, honors allow rules and session answers', () => {
    expect(checkPermission(BashTool, { command: 'ls' }, { ...base, settings: {} })).toBe('ask');
    const settings = { permissions: { allow: ['Bash(git:*)'] } };
    expect(checkPermission(BashTool, { command: 'git log' }, { ...base, settings })).toBe('allow');
    expect(checkPermission(BashTool, { command: 'ls' }, { ...base, settings: {}, sessionAllow: ['Bash(ls)'] })).toBe('allow');
  });
  it('lets deny beat allow', () => {
    const settings = { permissions: { allow: ['Read'], deny: ['Read(.env)'] } };
    expect(checkPermission(ReadTool, { file_path: '.env' }, { ...base, settings })).toBe('deny');
  });
});

describe('settings + registry', () => {
  it('deep-merges objects and unions arrays', () => {
    const merged = mergeSettings(
      { model: 'a', tools: { disabled: ['Bash'] }, permissions: { allow: ['Read'] } },
      { model: 'b', tools: { disabled: ['Grep'] } },
    );
    expect(merged).toEqual({ model: 'b', tools: { disabled: ['Bash', 'Grep'] }, permissions: { allow: ['Read'] } });
  });
  it('applies disabled tools and description overrides', () => {
    const settings = { tools: { disabled: ['Bash'], descriptions: { Read: 'custom' } } };
    expect(activeTools(settings).map((t) => t.name)).not.toContain('Bash');
    const read = toolStatuses(settings).find((s) => s.tool.name === 'Read')!;
    expect(read.tool.description).toBe('custom');
    expect(read.descriptionOverridden).toBe(true);
  });
});

import { tailLines } from '../src/ui/useRows.js';

describe('tailLines', () => {
  it('keeps everything that fits', () => {
    expect(tailLines('a\nb', 5)).toEqual({ text: 'a\nb', hidden: 0 });
  });
  it('keeps the last lines that fit and counts the rest', () => {
    expect(tailLines('1\n2\n3\n4\n5', 2)).toEqual({ text: '4\n5', hidden: 3 });
  });
  it('counts wrapped rows of long lines', () => {
    // 50 chars in a 20-column terminal = 3 rows, so with 3 rows only that line fits.
    expect(tailLines('short\n' + 'x'.repeat(50), 3, 20)).toEqual({ text: 'x'.repeat(50), hidden: 1 });
  });
});
