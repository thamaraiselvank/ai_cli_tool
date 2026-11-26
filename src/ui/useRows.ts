import { useEffect, useState } from 'react';
import { useStdout } from 'ink';


/**
 * Terminal height in rows, kept up to date on resize.
 *
 * Why this matters: Ink redraws the live (non-Static) part of the screen by moving the cursor up
 * and erasing what it drew last time. If that part is taller than the terminal, its top has
 * scrolled away and can't be erased — every redraw then leaves a stale copy behind (stacked
 * dialogs). So everything live must be sized to fit the current height.
 */
/** Ink types stdout as a generic stream; on a real terminal it's a TTY stream with rows/columns. */
export function useTerminal(): NodeJS.WriteStream {
  return useStdout().stdout as unknown as NodeJS.WriteStream;
}

export function useRows(): number {
  const stdout = useTerminal();
  const [rows, setRows] = useState(stdout.rows || 24);
  useEffect(() => {
    const onResize = () => setRows(stdout.rows || 24);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return rows;
}

/**
 * Keeps the end of `text` that fits in `max` screen rows (for streaming replies longer than the
 * screen). Counts wrapped rows, not just "\n": a 300-char line takes 3 rows in a 100-column terminal.
 */
export function tailLines(text: string, max: number, columns = 80): { text: string; hidden: number } {
  const lines = text.split('\n');
  const rowsOf = (l: string) => Math.max(1, Math.ceil(l.length / Math.max(20, columns)));
  let used = 0;
  let i = lines.length;
  while (i > 0 && used + rowsOf(lines[i - 1]!) <= max) used += rowsOf(lines[--i]!);
  if (i === 0) return { text, hidden: 0 };
  return { text: lines.slice(i).join('\n'), hidden: i };
}
