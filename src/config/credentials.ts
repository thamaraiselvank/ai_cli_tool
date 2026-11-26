import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * API keys, in priority order:
 *   1. environment variable (e.g. GROQ_API_KEY) — handy for CI and .env during development
 *   2. the OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service)
 *   3. ~/.jarvis/credentials.json (mode 600) — only when no keychain is available, e.g. a headless
 *      Linux server. Why keychain first: a plain file is readable by any process running as you
 *      and easy to leak in a backup or a screenshot; the keychain is encrypted at rest.
 */

const SERVICE = 'jarvis-code';
const FILE = path.join(os.homedir(), '.jarvis', 'credentials.json');

type KeyringEntry = { getPassword(): string | null; setPassword(p: string): void; deletePassword(): boolean };
type EntryCtor = new (service: string, account: string) => KeyringEntry;

// Loaded lazily and defensively: a native module can fail to load on unusual platforms, and that
// must never stop Jarvis from starting — we just fall back to the file.
let keyringCtor: EntryCtor | null | undefined;
function keyring(): EntryCtor | null {
  if (keyringCtor === undefined) {
    try {
      keyringCtor = (createRequire(import.meta.url)('@napi-rs/keyring') as { Entry: EntryCtor }).Entry;
    } catch {
      keyringCtor = null;
    }
  }
  return keyringCtor;
}

function readFile(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeFile(data: Record<string, string>) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export type KeySource = 'env' | 'keychain' | 'file';

export function getStoredKey(provider: string): { key: string; source: KeySource } | undefined {
  const Entry = keyring();
  if (Entry) {
    try {
      const key = new Entry(SERVICE, provider).getPassword();
      if (key) return { key, source: 'keychain' };
    } catch {
      /* keychain unavailable right now; try the file */
    }
  }
  const key = readFile()[provider];
  return key ? { key, source: 'file' } : undefined;
}

/** Saves a key; returns where it went. */
export function saveKey(provider: string, key: string): KeySource {
  const Entry = keyring();
  if (Entry) {
    try {
      new Entry(SERVICE, provider).setPassword(key);
      return 'keychain';
    } catch {
      /* fall through to the file */
    }
  }
  writeFile({ ...readFile(), [provider]: key });
  return 'file';
}

export function deleteKey(provider: string) {
  const Entry = keyring();
  if (Entry) {
    try {
      new Entry(SERVICE, provider).deletePassword();
    } catch {
      /* not there */
    }
  }
  const data = readFile();
  if (provider in data) {
    delete data[provider];
    writeFile(data);
  }
}

/** Env var wins (explicit beats stored), then whatever is saved. */
export function resolveKey(provider: string, envVar?: string): { key: string; source: KeySource } | undefined {
  const fromEnv = envVar ? process.env[envVar] : undefined;
  if (fromEnv) return { key: fromEnv, source: 'env' };
  return getStoredKey(provider);
}

/** "gsk_abcd…wxyz": enough to recognize a key, not enough to use it. */
export function maskKey(key: string): string {
  return key.length <= 10 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}
