import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { tailLines, useRows, useTerminal } from './useRows.js';
import { findCommand, matchCommands } from '../commands/index.js';
import { onboarding } from '../commands/provider.js';
import { resumePicker } from '../commands/session.js';
import { Session } from '../core/session.js';
import type { CommandContext } from '../commands/types.js';
import { loadSettings } from '../config/settings.js';
import { DialogView, type Dialog, type UI } from './dialogs.js';
import { runLoop, type PermissionAnswer } from '../core/loop.js';
import type { Message, ToolCall } from '../core/messages.js';
import type { Router } from '../providers/router.js';
import { buildSystemPrompt } from '../core/systemPrompt.js';
import { activeTools } from '../tools/registry.js';
import { formatTodos, type Todo } from '../tools/todo.js';
import type { Tool } from '../tools/types.js';

interface Props {
  router: Router;
  system: string;
  cwd: string;
  /** Where this conversation is saved (a new or a resumed one). */
  session: Session;
  /** History of a resumed conversation. */
  initialMessages?: Message[];
  /** `jarvis --resume` without an id: open the picker on start. */
  openResumePicker?: boolean;
}

const RECAP_MESSAGES = 30;

/** Turns a loaded history into screen items, so a resumed conversation shows where you left off. */
function recapItems(messages: Message[]): Item[] {
  const recent = messages.slice(-RECAP_MESSAGES);
  const items: Item[] = [];
  if (messages.length > recent.length) items.push({ kind: 'info', text: `… ${messages.length - recent.length} earlier messages` });
  for (const m of recent) {
    if (m.role === 'user') items.push({ kind: m.content.startsWith('[This conversation was compacted') ? 'info' : 'user', text: m.content });
    else if (m.role === 'assistant') {
      if (m.content.trim()) items.push({ kind: 'assistant', text: m.content.trim() });
      for (const c of m.toolCalls ?? []) items.push({ kind: 'tool-call', text: c.name });
    } else items.push({ kind: 'tool-result', text: summarize(m.content), isError: Boolean(m.isError) });
  }
  return items;
}

/** 12345 → "12.3k" */
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

type Item =
  | { kind: 'user' | 'assistant' | 'info' | 'error'; text: string }
  | { kind: 'tool-call' | 'diff' | 'progress' | 'todos'; text: string }
  | { kind: 'tool-result'; text: string; isError: boolean };

interface PendingPermission {
  tool: Tool;
  key: string;
  preview?: string;
  resolve: (a: PermissionAnswer) => void;
}

const MAX_DIFF_LINES = 40;

/** Colored unified diff. Long diffs are cut so the prompt stays on screen. */
function Diff({ text }: { text: string }) {
  const lines = text.split('\n');
  const shown = lines.slice(0, MAX_DIFF_LINES);
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((l, i) => (
        <Text key={i} color={l.startsWith('+') ? 'green' : l.startsWith('-') ? 'red' : l.startsWith('@@') ? 'cyan' : undefined}>
          {l || ' '}
        </Text>
      ))}
      {lines.length > MAX_DIFF_LINES && <Text dimColor>… {lines.length - MAX_DIFF_LINES} more diff lines</Text>}
    </Box>
  );
}

function summarize(output: string): string {
  const lines = output.split('\n');
  const first = lines[0]!.slice(0, 120);
  return lines.length > 1 ? `${first}  … (${lines.length} lines)` : first;
}

export function App({ router, system: initialSystem, cwd, session, initialMessages, openResumePicker }: Props) {
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>(() =>
    initialMessages?.length
      ? [{ kind: 'info', text: `Resumed conversation ${session.id} (${initialMessages.length} messages).` }, ...recapItems(initialMessages)]
      : [],
  );
  /** Context fill from the last request, for the status bar gauge. */
  const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null);
  const [live, setLive] = useState('');
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  /** A slash command is running (it may be waiting on a dialog or a network call). */
  const [busy, setBusy] = useState(false);
  /** Highlighted row in the "/" autocomplete menu. */
  const [suggestion, setSuggestion] = useState(0);

  // Refs, not state: the loop mutates history in place and must see "always allow" answers instantly.
  const history = useRef<Message[]>(initialMessages ?? []);
  const sessionRef = useRef(session);
  const sessionAllow = useRef<string[]>([]);
  const fileState = useRef(new Map<string, number>());
  const abort = useRef<AbortController | null>(null);
  /** Rebuilt each turn, so a JARVIS.md edit applies to the next message. Unchanged = same bytes. */
  const systemRef = useRef(initialSystem);

  const add = (item: Item) => setItems((xs) => [...xs, item]);

  function askPermission(_call: ToolCall, tool: Tool, key: string, preview?: string) {
    return new Promise<PermissionAnswer>((resolve) => setPending({ tool, key, preview, resolve }));
  }

  async function send(text: string) {
    add({ kind: 'user', text });
    history.current.push({ role: 'user', content: text });
    setRunning(true);
    const ac = new AbortController();
    abort.current = ac;
    let buffer = '';
    const flush = () => {
      if (buffer.trim()) add({ kind: 'assistant', text: buffer.trim() });
      buffer = '';
      setLive('');
    };

    try {
      // Settings are re-read every turn so `/tools disable X` takes effect on the next message.
      const settings = loadSettings(cwd);
      systemRef.current = buildSystemPrompt(cwd);
      for await (const ev of runLoop(history.current, {
        router, system: systemRef.current, cwd, settings,
        tools: activeTools(settings, cwd),
        abortSignal: ac.signal,
        askPermission,
        sessionAllow: sessionAllow.current,
        fileState: fileState.current,
        session: sessionRef.current,
      })) {
        if (ev.type === 'text') {
          buffer += ev.text;
          setLive(buffer);
        } else if (ev.type === 'tool-call') {
          flush();
          add({ kind: 'tool-call', text: `${ev.call.name}(${ev.display})` });
          // Keep the diff in the scrollback too, so you can see what changed after approving.
          if (ev.preview) add({ kind: 'diff', text: ev.preview });
        } else if (ev.type === 'tool-result') {
          if (ev.call.name === 'TodoWrite' && !ev.isError) {
            add({ kind: 'todos', text: formatTodos((ev.call.args as { todos: Todo[] }).todos) });
          } else add({ kind: 'tool-result', text: summarize(ev.output), isError: ev.isError });
        } else if (ev.type === 'progress') {
          add({ kind: 'progress', text: ev.text });
        } else if (ev.type === 'context') {
          setUsage({ used: ev.used, limit: ev.limit });
        } else {
          flush();
          add({ kind: 'info', text: ev.text });
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) add({ kind: 'error', text: (e as Error).message });
    } finally {
      // Whatever happened (error, Esc), keep what we have on disk.
      sessionRef.current.sync(history.current);
      flush();
      if (ac.signal.aborted) add({ kind: 'info', text: 'Interrupted.' });
      setRunning(false);
      abort.current = null;
    }
  }

  // ---- dialogs: commands `await ui.select(...)`; we render the open one and resolve on answer ----
  const ui: UI = {
    select: (o) => new Promise((resolve) => setDialog({ kind: 'select', ...o, resolve })),
    multiSelect: (o) => new Promise((resolve) => setDialog({ kind: 'multi', ...o, resolve })),
    input: (o) => new Promise((resolve) => setDialog({ kind: 'input', ...o, resolve })),
  };

  const ctx: CommandContext = {
    cwd,
    router,
    ui,
    print: (text, kind = 'info') => add({ kind, text }),
    setContextUsage: (used, limit) => setUsage({ used, limit }),
    conversation: {
      messages: () => history.current,
      session: () => sessionRef.current,
      get system() {
        return systemRef.current;
      },
      startNew: () => {
        history.current = [];
        sessionRef.current = Session.create(cwd);
        fileState.current.clear(); // the model "forgets" what it read, so it must Read again
        setUsage(null);
      },
      load: (messages, s) => {
        history.current = messages;
        sessionRef.current = s;
        // Files may have changed since that conversation: force fresh Reads before any Edit.
        fileState.current.clear();
        setUsage(null);
        add({ kind: 'info', text: `Resumed conversation ${s.id} (${messages.length} messages).` });
        for (const item of recapItems(messages)) add(item);
      },
    },
    exit,
  };

  async function runCommand(text: string) {
    const [name = '', ...args] = text.slice(1).trim().split(/\s+/);
    const cmd = findCommand(name);
    if (!cmd) return add({ kind: 'error', text: `Unknown command /${name}. Try /help` });
    setBusy(true);
    try {
      await cmd.run(args, ctx);
    } catch (e) {
      add({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
      setDialog(null);
    }
  }

  // On start: first run → provider + model setup; `jarvis --resume` → conversation picker.
  useEffect(() => {
    const task = router.chain.length === 0 ? onboarding(ctx) : openResumePicker ? resumePicker(ctx) : undefined;
    if (!task) return;
    setBusy(true);
    void task.finally(() => {
      setBusy(false);
      setDialog(null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "/" menu: while typing a command name (no space yet), list matching commands.
  const suggestions = input.startsWith('/') && !input.includes(' ') ? matchCommands(input.slice(1)) : [];
  const sel = Math.min(suggestion, Math.max(0, suggestions.length - 1));

  // Everything below <Static> is redrawn on each change and must fit the terminal (see useRows.ts).
  // Budget: input box (3) + status bar (1) + one spare.
  const rows = useRows();
  const stdout = useTerminal();
  const menuSize = Math.max(2, Math.min(suggestions.length, rows - 7));
  const menuStart = Math.max(0, Math.min(sel - menuSize + 1, suggestions.length - menuSize));
  const liveView = tailLines(live, Math.max(3, rows - 6), stdout.columns || 80);

  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') return exit();

    if (pending) {
      const answer: PermissionAnswer | null =
        ch === 'y' ? 'allow' : ch === 'a' ? 'always' : ch === 'n' || key.escape ? 'deny' : null;
      if (answer) {
        pending.resolve(answer);
        setPending(null);
      }
      return;
    }
    if (key.escape && abort.current) return abort.current.abort();
    if (running || busy) return; // typing is ignored while the agent or a command works

    if (suggestions.length) {
      if (key.upArrow) return setSuggestion(sel <= 0 ? suggestions.length - 1 : sel - 1);
      if (key.downArrow) return setSuggestion(sel >= suggestions.length - 1 ? 0 : sel + 1);
      if (key.tab) return setInput(`/${suggestions[sel]!.name} `);
      if (key.escape) return setInput('');
    }

    if (key.return) {
      let text = input.trim();
      setInput('');
      setSuggestion(0);
      if (!text) return;
      if (text.startsWith('/')) {
        // "/mo" + Enter runs the highlighted match, so you rarely type a full command name.
        if (suggestions.length && !findCommand(text.slice(1))) text = `/${suggestions[sel]!.name}`;
        return void runCommand(text);
      }
      void send(text);
      return;
    }
    if (key.backspace || key.delete) return setInput((s) => s.slice(0, -1));
    if (ch && !key.ctrl && !key.meta) {
      setSuggestion(0);
      setInput((s) => s + ch);
    }
  }, { isActive: !dialog });

  return (
    <Box flexDirection="column">
      {/* Static = printed once and never re-rendered: keeps long sessions fast. */}
      <Static items={items}>
        {(item, i) => (
          <Box key={i} marginBottom={item.kind === 'tool-call' || item.kind === 'diff' || item.kind === 'progress' ? 0 : 1}>
            {/* The diff is printed here, right above the permission box, so the box stays small. */}
            {item.kind === 'diff' && <Diff text={item.text} />}
            {item.kind === 'user' && <Text color="cyan">{'> '}{item.text}</Text>}
            {item.kind === 'assistant' && <Text>{item.text}</Text>}
            {item.kind === 'tool-call' && <Text color="yellow">● {item.text}</Text>}
            {item.kind === 'progress' && <Text dimColor>    ↳ {item.text}</Text>}
            {item.kind === 'todos' && (
              <Box flexDirection="column" marginLeft={2}>
                {item.text.split('\n').map((l, j) => (
                  <Text key={j} color={l.startsWith('☑') ? 'green' : l.startsWith('◐') ? 'yellow' : undefined} dimColor={l.startsWith('☑')}>
                    {l}
                  </Text>
                ))}
              </Box>
            )}
            {item.kind === 'tool-result' && (
              <Text color={item.isError ? 'red' : 'gray'}>  ⎿ {item.text}</Text>
            )}
            {item.kind === 'info' && <Text dimColor>{item.text}</Text>}
            {item.kind === 'error' && <Text color="red">Error: {item.text}</Text>}
          </Box>
        )}
      </Static>

      {/* While streaming, show only the tail that fits; the full reply is printed when it's done. */}
      {live && liveView.hidden > 0 && <Text dimColor>… {liveView.hidden} earlier lines (shown in full when done)</Text>}
      {live && <Text>{liveView.text}</Text>}
      {running && !live && !pending && <Text dimColor>working… (Esc to stop)</Text>}

      {dialog ? (
        <DialogView dialog={dialog} close={() => setDialog(null)} />
      ) : pending ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text>
            Allow <Text bold>{pending.tool.name}</Text>: <Text color="yellow">{pending.key}</Text>
          </Text>
          <Text dimColor>[y] yes   [a] always this session   [n] no</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box borderStyle="round" paddingX={1}>
            <Text color="cyan">{'> '}</Text>
            <Text>{input}</Text>
            {!running && !busy && <Text inverse> </Text>}
            {!input && !running && !busy && <Text dimColor> Ask anything, or type / for commands</Text>}
          </Box>
          {suggestions.slice(menuStart, menuStart + menuSize).map((c, j) => {
            const i = menuStart + j;
            return (
              <Text key={c.name} color={i === sel ? 'cyan' : undefined} dimColor={i !== sel} wrap="truncate">
                {i === sel ? '❯ ' : '  '}/{c.name}
                {c.args ? ` ${c.args}` : ''}  — {c.description}
              </Text>
            );
          })}
          {suggestions.length > 0 && (
            <Text dimColor wrap="truncate">
              {'  '}
              {suggestions.length > menuSize ? `${sel + 1}/${suggestions.length} · ` : ''}↑↓ choose · Tab complete · Enter run
            </Text>
          )}
        </Box>
      )}
      <StatusBar router={router} usage={usage} />
    </Box>
  );
}

function StatusBar({ router, usage }: { router: Router; usage: { used: number; limit: number } | null }) {
  const t = router.totals();
  const model = router.lastModel ?? router.chain[0];
  const fellBack = router.lastModel && router.lastModel !== router.chain[0];
  const pct = usage ? Math.round((100 * usage.used) / usage.limit) : undefined;
  return (
    // One line, always: a wrapping status bar would break the height budget in narrow terminals.
    <Text wrap="truncate">
      <Text color={!model ? 'red' : fellBack ? 'yellow' : undefined} dimColor={Boolean(model) && !fellBack}>
        {model ?? 'no model — /model'}
        {fellBack ? ' (fallback)' : ''}
      </Text>
      {pct !== undefined && (
        // Green → yellow → red as it approaches the compaction threshold.
        <Text color={pct >= 70 ? 'red' : pct >= 45 ? 'yellow' : 'green'}> · context {pct}%</Text>
      )}
      <Text dimColor>
        {' '}· ↑{k(t.input)}{t.cacheRead ? ` (${k(t.cacheRead)} cached)` : ''} ↓{k(t.output)} · /help · Esc stop · Ctrl+C quit
      </Text>
    </Text>
  );
}
