export interface OutputLimits {
  maxLines: number;
  maxBytes: number;
}

export const DEFAULT_LIMITS: OutputLimits = { maxLines: 400, maxBytes: 30_000 };

/**
 * Caps tool output before it enters the conversation. Why: every byte of a tool result is re-sent on
 * every later request, so one `cat` of a big file could blow the context window or a free tier's
 * tokens-per-minute budget. The note tells the model how to get the rest (narrower read/search).
 */
export function capOutput(text: string, limits: OutputLimits = DEFAULT_LIMITS): string {
  let lines = text.split('\n');
  const totalLines = lines.length;
  let cut = false;
  if (lines.length > limits.maxLines) {
    lines = lines.slice(0, limits.maxLines);
    cut = true;
  }
  let out = lines.join('\n');
  if (Buffer.byteLength(out, 'utf8') > limits.maxBytes) {
    out = Buffer.from(out, 'utf8').subarray(0, limits.maxBytes).toString('utf8');
    // Drop a possibly half-cut last line (and any broken multi-byte char at the end).
    out = out.slice(0, out.lastIndexOf('\n') + 1 || out.length);
    cut = true;
  }
  if (!cut) return text;
  const shown = out.split('\n').length;
  return `${out}\n… [output truncated: showed ~${shown} of ${totalLines} lines. Narrow the request (offset/limit, a more specific pattern) to see more.]`;
}
