import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { BUILTIN_AGENTS } from '../agents/index.js';
import { HOOK_EVENTS } from '../hooks/index.js';
import { discoverModels, providerStatuses } from '../providers/discovery.js';
import { getProvider, validateKey } from '../providers/index.js';
import { BUILTIN_TOOLS } from '../tools/registry.js';
import { deleteKey, saveKey } from './credentials.js';
import { UI_PAGE } from './uiPage.js';
import { validateSettings } from './schema.js';
import { loadSettings, readSettingsFile, settingsPath, type Settings, type SettingsScope } from './settings.js';
import { isTrusted, trustProject, untrustedCommands } from './trust.js';

/**
 * `jarvis ui`: a settings page served on localhost.
 *
 * A local server is reachable by *every website you visit* (your browser will happily send
 * requests to 127.0.0.1), and these settings can define hooks, i.e. commands. So:
 *  - we listen on 127.0.0.1 only (not reachable from the network),
 *  - every API call needs a random token that only the URL we open contains (blocks CSRF: another
 *    site can send requests but can't know the token),
 *  - the Host header must be 127.0.0.1/localhost (blocks DNS rebinding, where evil.com is made to
 *    resolve to 127.0.0.1 so the browser treats our server as same-origin with it).
 */

export interface UiOptions {
  cwd: string;
  token: string;
  /** For tests: where the global settings + trust list live. */
  home?: string;
}

const SCOPES: SettingsScope[] = ['global', 'project', 'local'];

function scopeFile(scope: SettingsScope, o: UiOptions): string {
  return o.home && scope === 'global' ? path.join(o.home, '.jarvis', 'settings.json') : settingsPath(scope, o.cwd);
}

function sameToken(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function createUiApp(o: UiOptions): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') return c.text('Forbidden host', 403);
    await next();
    // The page is self-contained; nothing should load from elsewhere, and nobody may frame it.
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer'); // the URL holds the token
    c.header('Cache-Control', 'no-store');
  });

  app.use('/api/*', async (c, next) => {
    if (!sameToken(c.req.header('x-jarvis-token'), o.token)) return c.json({ error: 'Missing or wrong token. Reopen the link printed by `jarvis ui`.' }, 401);
    await next();
  });

  app.get('/', (c) => c.html(UI_PAGE));

  app.get('/api/state', async (c) => c.json(await state(o)));

  app.put('/api/settings/:scope', async (c) => {
    const scope = c.req.param('scope') as SettingsScope;
    if (!SCOPES.includes(scope)) return c.json({ error: `Unknown scope "${scope}"` }, 400);
    let data: unknown;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ error: 'Body is not valid JSON' }, 400);
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return c.json({ error: 'Settings must be a JSON object' }, 400);
    const errors = validateSettings(data);
    if (errors.length) return c.json({ error: 'Not saved: fix these first.', details: errors }, 400);
    const file = scopeFile(scope, o);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    return c.json({ saved: file, state: await state(o) });
  });

  app.post('/api/trust', async (c) => {
    trustProject(o.cwd, o.home);
    return c.json({ state: await state(o) });
  });

  app.post('/api/keys/:provider', async (c) => {
    const provider = c.req.param('provider');
    const { key } = (await c.req.json().catch(() => ({}))) as { key?: string };
    if (!key?.trim()) return c.json({ error: 'Paste a key first.' }, 400);
    try {
      await validateKey(provider, key.trim(), loadSettings(o.cwd, o.home).providers);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const where = saveKey(provider, key.trim());
    return c.json({ saved: where, state: await state(o) });
  });

  app.delete('/api/keys/:provider', async (c) => {
    deleteKey(c.req.param('provider'));
    return c.json({ state: await state(o) });
  });

  app.get('/api/models', async (c) => c.json(await discoverModels(loadSettings(o.cwd, o.home))));

  return app;
}

async function state(o: UiOptions) {
  const effective: Settings = loadSettings(o.cwd, o.home);
  const scopes = Object.fromEntries(
    SCOPES.map((s) => {
      const file = scopeFile(s, o);
      let data: Settings = {};
      let error: string | undefined;
      try {
        data = readSettingsFile(file);
      } catch (e) {
        error = (e as Error).message;
      }
      return [s, { file, exists: fs.existsSync(file), data, error }];
    }),
  );
  return {
    cwd: o.cwd,
    trusted: isTrusted(o.cwd, o.home),
    untrusted: untrustedCommands(o.cwd, o.home),
    scopes,
    effective,
    tools: BUILTIN_TOOLS.map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly })),
    agents: BUILTIN_AGENTS.map((a) => a.name),
    hookEvents: HOOK_EVENTS,
    providers: (await providerStatuses(effective)).map((p) => ({ ...p, baseURL: getProvider(p.name, effective.providers).baseURL })),
  };
}

/** Opens a URL in the default browser. Best effort: the URL is printed anyway. */
export function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'win32'
      ? // `start` is a cmd builtin; the empty "" is the window title, else a quoted URL becomes it.
        ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch {
    /* no browser available: the printed URL still works */
  }
}

export interface RunningUi {
  url: string;
  close(): Promise<void>;
}

/** Starts the server on 127.0.0.1 (port 0 = any free port). */
export function startUi(cwd: string, port = 0): Promise<RunningUi> {
  const token = randomBytes(24).toString('hex');
  const app = createUiApp({ cwd, token });
  return new Promise((resolve, reject) => {
    let server: ServerType;
    try {
      server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info: AddressInfo) => {
        resolve({
          url: `http://127.0.0.1:${info.port}/?token=${token}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
      server.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}
