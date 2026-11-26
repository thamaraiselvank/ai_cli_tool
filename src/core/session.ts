import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Message } from './messages.js';

/**
 * Session transcripts: one JSONL file per conversation, grouped by project folder.
 *
 *   ~/.jarvis/projects/<project-slug>/<yyyy-mm-dd_hhmm>_<id>.jsonl
 *
 * Why JSONL (one JSON object per line) and append-only: each message is one small append, so a
 * crash or Ctrl+C loses at most the line being written, and we never rewrite a big file.
 *
 * Line types:
 *   {"t":"meta", ...}               written once, first line
 *   {"t":"msg","m":Message}         one per message, in order
 *   {"t":"reset","messages":[…]}    full replacement after compaction / clearing tool output
 * Loading replays the lines: msg → push, reset → replace. So the file is also a full history of
 * what happened, including the original messages from before a compaction.
 */

type Entry =
  | { t: 'meta'; v: 1; id: string; cwd: string; created: string }
  | { t: 'msg'; ts: string; m: Message }
  | { t: 'reset'; ts: string; messages: Message[] };

export interface SessionInfo {
  id: string;
  file: string;
  title: string;
  updated: Date;
  messages: number;
}

/** "F:\ai_cli_tool" → "f--ai-cli-tool". Lowercased on Windows, where paths are case-insensitive. */
export function projectSlug(cwd: string): string {
  const abs = path.resolve(cwd);
  return (process.platform === 'win32' ? abs.toLowerCase() : abs).replace(/[^a-zA-Z0-9]/g, '-');
}

export function projectDir(cwd: string): string {
  return path.join(os.homedir(), '.jarvis', 'projects', projectSlug(cwd));
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function readEntries(file: string): Entry[] {
  const out: Entry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Entry);
    } catch {
      /* a half-written last line after a crash: skip it */
    }
  }
  return out;
}

function replay(entries: Entry[]): Message[] {
  let messages: Message[] = [];
  for (const e of entries) {
    if (e.t === 'msg') messages.push(e.m);
    else if (e.t === 'reset') messages = [...e.messages];
  }
  return messages;
}

function titleOf(messages: Message[]): string {
  // Skip a compaction summary: the first *real* request is a better title.
  const first = messages.find((m) => m.role === 'user' && !m.content.startsWith('[This conversation was compacted'));
  const line = (first?.content ?? '(empty)').split('\n')[0]!.trim();
  return line.length > 70 ? line.slice(0, 67) + '…' : line;
}

export class Session {
  /** How many messages of the in-memory history are already on disk. */
  private written = 0;
  private started = false;

  private constructor(
    readonly id: string,
    readonly file: string,
    private readonly cwd: string,
  ) {}

  /** A new session. The file is created lazily on the first message, so empty sessions leave no trace. */
  static create(cwd: string): Session {
    const id = crypto.randomBytes(4).toString('hex');
    return new Session(id, path.join(projectDir(cwd), `${stamp()}_${id}.jsonl`), cwd);
  }

  static load(file: string, cwd: string): { session: Session; messages: Message[] } {
    const entries = readEntries(file);
    const meta = entries.find((e) => e.t === 'meta');
    const id = meta?.t === 'meta' ? meta.id : path.basename(file, '.jsonl');
    const session = new Session(id, file, cwd);
    const messages = replay(entries);
    session.started = true;
    session.written = messages.length;
    return { session, messages };
  }

  /** This project's sessions, newest first. */
  static list(cwd: string, limit = 30): SessionInfo[] {
    const dir = projectDir(cwd);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const file = path.join(dir, f);
        return { file, mtime: fs.statSync(file).mtime };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, limit)
      .map(({ file, mtime }) => {
        const entries = readEntries(file);
        const messages = replay(entries);
        const meta = entries.find((e) => e.t === 'meta');
        return {
          id: meta?.t === 'meta' ? meta.id : path.basename(file, '.jsonl'),
          file,
          title: titleOf(messages),
          updated: mtime,
          messages: messages.filter((m) => m.role !== 'tool').length,
        };
      })
      .filter((s) => s.messages > 0);
  }

  static latest(cwd: string): SessionInfo | undefined {
    return Session.list(cwd, 1)[0];
  }

  /** Finds a session by id (or id prefix) in this project. */
  static find(cwd: string, id: string): SessionInfo | undefined {
    return Session.list(cwd, 1000).find((s) => s.id.startsWith(id));
  }

  private append(entries: Entry[]) {
    if (!this.started) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      entries.unshift({ t: 'meta', v: 1, id: this.id, cwd: path.resolve(this.cwd), created: new Date().toISOString() });
      this.started = true;
    }
    fs.appendFileSync(this.file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  /** Writes any messages not yet on disk. Cheap to call often. */
  sync(messages: Message[]) {
    if (messages.length < this.written) return this.rewrite(messages); // history shrank: must be a rewrite
    if (messages.length === this.written) return;
    const ts = new Date().toISOString();
    this.append(messages.slice(this.written).map((m) => ({ t: 'msg' as const, ts, m })));
    this.written = messages.length;
  }

  /** Records a full replacement of the history (after compaction or clearing tool output). */
  rewrite(messages: Message[]) {
    this.append([{ t: 'reset', ts: new Date().toISOString(), messages }]);
    this.written = messages.length;
  }
}
