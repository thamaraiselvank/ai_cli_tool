import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validateSettings } from '../src/config/schema.js';
import { createUiApp, startUi } from '../src/config/ui.js';
import { UI_PAGE } from '../src/config/uiPage.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ui-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const home = path.join(tmp, 'home');
const cwd = path.join(tmp, 'project');
fs.mkdirSync(cwd, { recursive: true });
const token = 'a'.repeat(48);
const app = createUiApp({ cwd, token, home });

function req(p: string, init: RequestInit & { host?: string; noToken?: boolean } = {}) {
  const headers = new Headers(init.headers);
  headers.set('host', init.host ?? '127.0.0.1:4321');
  if (!init.noToken) headers.set('x-jarvis-token', token);
  if (init.body) headers.set('content-type', 'application/json');
  return app.request(`http://127.0.0.1:4321${p}`, { ...init, headers });
}

describe('settings schema', () => {
  it('accepts a full, valid settings object and keeps unknown keys', () => {
    expect(
      validateSettings({
        model: 'groq/openai/gpt-oss-120b',
        fallbacks: ['ollama/qwen2.5-coder'],
        permissions: { allow: ['Bash(npm test:*)', 'mcp__github__*'], deny: ['Read(.env)'] },
        hooks: { Stop: [{ command: 'npm test' }] },
        mcpServers: { fs: { command: 'npx', args: ['-y', 'x'] }, gh: { url: 'https://x.dev/mcp' } },
        context: { compactAt: 0.8 },
        futureSetting: { anything: true },
      }),
    ).toEqual([]);
  });

  it('explains what is wrong', () => {
    const errors = validateSettings({
      model: 'no-slash',
      permissions: { allow: ['Bash(unclosed'] },
      hooks: { OnBoot: [{ command: 'x' }], Stop: [{ command: '' }] },
      mcpServers: { both: { command: 'a', url: 'https://x.dev' } },
      context: { compactAt: 2 },
    });
    const text = errors.join('\n');
    expect(text).toMatch(/^model: use provider\/model/m);
    expect(text).toMatch(/permissions\.allow\.0: not a valid rule/);
    expect(text).toMatch(/hooks/);
    expect(text).toMatch(/mcpServers\.both: give either "command"/);
    expect(text).toMatch(/context\.compactAt/);
  });
});

describe('jarvis ui server', () => {
  it('serves the page with a strict content security policy', async () => {
    const r = await req('/', { noToken: true });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('<title>Jarvis settings</title>');
    expect(r.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
  });

  it('rejects other host names (DNS rebinding) and calls without the token (CSRF)', async () => {
    expect((await req('/api/state', { host: 'evil.example:4321' })).status).toBe(403);
    expect((await req('/api/state', { noToken: true })).status).toBe(401);
    expect((await req('/api/state', { headers: { 'x-jarvis-token': 'b'.repeat(48) }, noToken: true })).status).toBe(401);
  });

  it('reports the state of all three settings files', async () => {
    const s = (await (await req('/api/state')).json()) as {
      cwd: string; trusted: boolean; scopes: Record<string, { file: string; exists: boolean }>; tools: { name: string }[];
    };
    expect(s.cwd).toBe(cwd);
    expect(s.trusted).toBe(false);
    expect(s.scopes.global!.file).toBe(path.join(home, '.jarvis', 'settings.json'));
    expect(s.scopes.local!.file).toBe(path.join(cwd, '.jarvis', 'settings.local.json'));
    expect(s.tools.map((t) => t.name)).toContain('Bash');
  });

  it('saves valid settings and refuses invalid ones without touching the file', async () => {
    const ok = await req('/api/settings/project', { method: 'PUT', body: JSON.stringify({ model: 'groq/m', custom: 1 }) });
    expect(ok.status).toBe(200);
    const file = path.join(cwd, '.jarvis', 'settings.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ model: 'groq/m', custom: 1 });

    const bad = await req('/api/settings/project', { method: 'PUT', body: JSON.stringify({ permissions: { allow: ['(('] } }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { details: string[] }).details[0]).toMatch(/permissions\.allow\.0/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ model: 'groq/m', custom: 1 });

    expect((await req('/api/settings/elsewhere', { method: 'PUT', body: '{}' })).status).toBe(400);
    expect((await req('/api/settings/global', { method: 'PUT', body: '[1]' })).status).toBe(400);
  });

  it('can trust the folder, which unlocks its allow rules', async () => {
    await req('/api/settings/local', { method: 'PUT', body: JSON.stringify({ permissions: { allow: ['Bash'] } }) });
    let s = (await (await req('/api/state')).json()) as { effective: { permissions?: { allow?: string[] } } };
    expect(s.effective.permissions?.allow).toBeUndefined(); // untrusted: ignored
    s = ((await (await req('/api/trust', { method: 'POST' })).json()) as { state: typeof s }).state;
    expect(s.effective.permissions?.allow).toEqual(['Bash']);
  });

  it('refuses an empty API key without calling the provider', async () => {
    const r = await req('/api/keys/groq', { method: 'POST', body: JSON.stringify({ key: ' ' }) });
    expect(r.status).toBe(400);
  });

  it('listens on 127.0.0.1 with a token in the link', async () => {
    const ui = await startUi(cwd);
    try {
      const url = new URL(ui.url);
      expect(url.hostname).toBe('127.0.0.1');
      expect(url.searchParams.get('token')).toMatch(/^[0-9a-f]{48}$/);
      const r = await fetch(new URL('/api/state', url), { headers: { 'x-jarvis-token': url.searchParams.get('token')! } });
      expect(r.status).toBe(200);
    } finally {
      await ui.close();
    }
  });
});

describe('settings page', () => {
  it('contains a script that parses as valid JavaScript', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(UI_PAGE)![1]!;
    expect(() => new Function(script)).not.toThrow();
  });

  it('kept ${VAR} examples literal (the page is a template string)', () => {
    expect(UI_PAGE).toContain("'Bearer $' + '{GITHUB_TOKEN}'");
    expect(UI_PAGE).toContain('&#36;{GITHUB_TOKEN}');
  });
});
