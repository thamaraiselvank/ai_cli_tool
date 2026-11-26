import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useRows } from './useRows.js';

export interface SelectItem {
  label: string;
  value: string;
  /** Dim text after the label, e.g. "current" or "✓ key saved". */
  hint?: string;
}

/**
 * Promise-based dialogs: a slash command can simply `await ui.select(...)` and get the answer,
 * like a prompt in a normal script. The App renders whichever dialog is open and resolves the
 * promise when the user picks or presses Esc (→ undefined).
 */
export interface UI {
  select(o: { title: string; items: SelectItem[]; initial?: string }): Promise<string | undefined>;
  multiSelect(o: { title: string; items: SelectItem[]; selected?: string[] }): Promise<string[] | undefined>;
  input(o: { title: string; mask?: boolean; hint?: string }): Promise<string | undefined>;
}

export type Dialog =
  | { kind: 'select'; title: string; items: SelectItem[]; initial?: string; resolve: (v: string | undefined) => void }
  | { kind: 'multi'; title: string; items: SelectItem[]; selected?: string[]; resolve: (v: string[] | undefined) => void }
  | { kind: 'input'; title: string; mask?: boolean; hint?: string; resolve: (v: string | undefined) => void };

/**
 * Lines a SelectList uses besides its rows: 2 border + title + key help, plus the status bar under
 * it and 2 spare (e.g. "(no matches)"). See useRows.ts for why the total must fit the terminal.
 */
const DIALOG_CHROME = 7;
const MAX_WINDOW = 10;

/** Arrow-key list. Type to filter (lists like OpenRouter's have hundreds of models). */
export function SelectList(props: {
  title: string;
  items: SelectItem[];
  multi?: boolean;
  initial?: string;
  selected?: string[];
  onDone: (v: string | string[] | undefined) => void;
}) {
  const { items, multi } = props;
  const rows = useRows();
  const WINDOW = Math.max(3, Math.min(MAX_WINDOW, rows - DIALOG_CHROME));
  const [filter, setFilter] = useState('');
  const visible = items.filter((i) => i.label.toLowerCase().includes(filter.toLowerCase()));
  const [cursor, setCursor] = useState(() => Math.max(0, items.findIndex((i) => i.value === props.initial)));
  // Selection order matters for /fallback: the order you tick models is the order they're tried.
  const [picked, setPicked] = useState<string[]>(props.selected ?? []);
  const pos = Math.min(cursor, Math.max(0, visible.length - 1));

  useInput((ch, key) => {
    if (key.escape) return props.onDone(undefined);
    if (key.upArrow) return setCursor(pos <= 0 ? visible.length - 1 : pos - 1);
    if (key.downArrow) return setCursor(pos >= visible.length - 1 ? 0 : pos + 1);
    if (key.return) {
      if (multi) return props.onDone(picked);
      const item = visible[pos];
      return item ? props.onDone(item.value) : undefined;
    }
    if (multi && ch === ' ') {
      const item = visible[pos];
      if (!item) return;
      return setPicked((p) => (p.includes(item.value) ? p.filter((v) => v !== item.value) : [...p, item.value]));
    }
    if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
      return setCursor(0);
    }
    if (ch && !key.ctrl && !key.meta && /^[\w./:@-]+$/.test(ch)) {
      setFilter((f) => f + ch);
      setCursor(0);
    }
  });

  // Scroll a fixed-size window around the cursor.
  const start = Math.max(0, Math.min(pos - Math.floor(WINDOW / 2), visible.length - WINDOW));
  const shown = visible.slice(start, start + WINDOW);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* Title and filter share one line, and every row is cut to one line (wrap="truncate"):
          a wrapped row would make the box taller than we budgeted for. */}
      <Text wrap="truncate">
        <Text bold>{props.title}</Text>
        <Text dimColor>{filter ? `  filter: ${filter}` : '  (type to filter)'}</Text>
      </Text>
      {visible.length === 0 && <Text dimColor>(no matches)</Text>}
      {shown.map((item, i) => {
        const active = start + i === pos;
        const order = picked.indexOf(item.value);
        return (
          <Text key={item.value} color={active ? 'cyan' : undefined} wrap="truncate">
            {active ? '❯ ' : '  '}
            {multi ? (order >= 0 ? `[${order + 1}] ` : '[ ] ') : ''}
            {item.label}
            {item.hint ? <Text dimColor>  {item.hint}</Text> : null}
          </Text>
        );
      })}
      <Text dimColor wrap="truncate">
        {visible.length > WINDOW ? `${pos + 1}/${visible.length} · ` : ''}↑↓ move ·{' '}
        {multi ? 'Space pick (order = priority) · Enter save' : 'Enter choose'} · Esc cancel
      </Text>
    </Box>
  );
}

/** Single-line text input; `mask` hides what you type (for API keys). */
export function InputDialog(props: { title: string; mask?: boolean; hint?: string; onDone: (v: string | undefined) => void }) {
  const [value, setValue] = useState('');
  useInput((ch, key) => {
    if (key.escape) return props.onDone(undefined);
    if (key.return) return props.onDone(value.trim());
    if (key.backspace || key.delete) return setValue((v) => v.slice(0, -1));
    // Pasted text arrives as one chunk; strip line breaks a terminal paste may include.
    if (ch && !key.ctrl && !key.meta) setValue((v) => v + ch.replace(/[\r\n]/g, ''));
  });
  const shown = props.mask ? '•'.repeat(Math.min(value.length, 40)) : value;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{props.title}</Text>
      {props.hint && <Text dimColor>{props.hint}</Text>}
      <Text>
        {'> '}
        {shown}
        <Text inverse> </Text>
      </Text>
      <Text dimColor>Enter confirm · Esc cancel{props.mask ? ' · input is hidden' : ''}</Text>
    </Box>
  );
}

export function DialogView({ dialog, close }: { dialog: Dialog; close: () => void }) {
  const done = (v: any) => {
    close();
    dialog.resolve(v);
  };
  if (dialog.kind === 'input') return <InputDialog {...dialog} onDone={done} />;
  return (
    <SelectList
      title={dialog.title}
      items={dialog.items}
      multi={dialog.kind === 'multi'}
      initial={dialog.kind === 'select' ? dialog.initial : undefined}
      selected={dialog.kind === 'multi' ? dialog.selected : undefined}
      onDone={done}
    />
  );
}
