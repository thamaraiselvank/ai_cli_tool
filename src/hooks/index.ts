import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettingsFile } from '../config/settings.js';
import { settingsSources } from '../config/trust.js';
import { runShell } from '../tools/shell.js';

/**
 * Hooks: user shell commands that run at fixed points of the loop. They turn "please always run
 * prettier after editing" from a hope (the model may forget) into a guarantee (the harness does it).
 *
 * Events:
 *   PreToolUse        before a tool runs; can block it (and say why) or pre-approve it
 *   PostToolUse       after a tool ran; can send feedback to the model (e.g. lint errors)
 *   UserPromptSubmit  before a prompt goes to the model; can block it or add context
 *   Stop              when the model is about to finish; can make it keep going (e.g. tests fail)
 *
 * Protocol (kept simple on purpose so any language works):
 *   in:   JSON on stdin + JARVIS_* env vars
 *   out:  exit 0 = fine (stdout may be JSON {"decision","reason"}; for UserPromptSubmit plain
 *                 stdout is added as context)
 *         exit 2 = "no" — block / feed stderr back to the model
 *         other  = the hook itself is broken: shown to the user, never blocks
 */

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookConfig {
  /** Regex on the tool name (PreToolUse/PostToolUse), e.g. "Edit|Write" or "mcp__github__.*". */
  matcher?: string;
  command: string;
  /** Seconds (default 60). */
  timeout?: number;
}

export type HooksSettings = Partial<Record<HookEvent, HookConfig[]>>;

export interface LoadedHook extends HookConfig {
  event: HookEvent;
  /** Settings file it came from (shown by /hooks). */
  source: string;
}

export interface HookPayload {
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: string;
  is_error?: boolean;
  prompt?: string;
  /** Stop: the model's final message. */
  last_message?: string;
}

export interface HookResult {
  /** Set when a hook said no (exit 2 or decision "block"): the reason. */
  block?: string;
  /** PreToolUse: a hook pre-approved the call (decision "allow"), so skip the prompt. */
  allow?: boolean;
  /** Extra text for the model (UserPromptSubmit stdout, or "context" in JSON output). */
  context: string[];
  /** Broken hooks (crash, timeout, bad exit code): for the user, not the model. */
  errors: string[];
}

const DEFAULT_TIMEOUT_S = 60;
/** Hook output is untrusted size-wise too; it goes into the model's context. */
const MAX_HOOK_OUTPUT = 10_000;

export function loadHooks(cwd: string, home = os.homedir()): { hooks: LoadedHook[]; errors: string[] } {
  const hooks: LoadedHook[] = [];
  const errors: string[] = [];
  for (const src of settingsSources(cwd, home).filter((s) => s.trusted)) {
    if (!fs.existsSync(src.file)) continue;
    let data: { hooks?: HooksSettings };
    try {
      data = readSettingsFile(src.file);
    } catch (e) {
      errors.push((e as Error).message);
      continue;
    }
    for (const [event, list] of Object.entries(data.hooks ?? {})) {
      if (!HOOK_EVENTS.includes(event as HookEvent)) {
        errors.push(`${src.file}: unknown hook event "${event}" (use ${HOOK_EVENTS.join(', ')})`);
        continue;
      }
      for (const h of Array.isArray(list) ? list : []) {
        if (typeof h?.command !== 'string' || !h.command.trim()) {
          errors.push(`${src.file}: a ${event} hook has no "command"`);
          continue;
        }
        hooks.push({ ...h, event: event as HookEvent, source: src.file });
      }
    }
  }
  return { hooks, errors };
}

/** Anchored regex; an invalid pattern falls back to an exact name match instead of crashing. */
export function matches(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === '*') return true;
  if (!toolName) return false;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_HOOK_OUTPUT ? `${t.slice(0, MAX_HOOK_OUTPUT)}\n[… hook output truncated]` : t;
}

/** The file a tool call touches, for $JARVIS_FILE (handy for "format the edited file"). */
function filePathOf(input: unknown, cwd: string): string | undefined {
  const p = (input as { file_path?: unknown } | undefined)?.file_path;
  return typeof p === 'string' ? path.resolve(cwd, p) : undefined;
}

export class HookRunner {
  constructor(
    private readonly hooks: LoadedHook[],
    private readonly cwd: string,
    private readonly sessionId?: string,
  ) {}

  static load(cwd: string, sessionId?: string): HookRunner {
    return new HookRunner(loadHooks(cwd).hooks, cwd, sessionId);
  }

  has(event: HookEvent, toolName?: string): boolean {
    return this.hooks.some((h) => h.event === event && (toolName === undefined || matches(h.matcher, toolName)));
  }

  /** Runs the matching hooks in order. The first "block" stops the rest (no point asking further). */
  async run(event: HookEvent, payload: HookPayload, signal?: AbortSignal): Promise<HookResult> {
    const result: HookResult = { context: [], errors: [] };
    const toolEvent = event === 'PreToolUse' || event === 'PostToolUse';
    const list = this.hooks.filter((h) => h.event === event && (!toolEvent || matches(h.matcher, payload.tool_name)));

    for (const h of list) {
      const input = JSON.stringify({ event, cwd: this.cwd, session_id: this.sessionId, ...payload });
      const file = filePathOf(payload.tool_input, this.cwd);
      const r = await runShell(h.command, {
        cwd: this.cwd,
        timeoutMs: (h.timeout ?? DEFAULT_TIMEOUT_S) * 1000,
        signal,
        input,
        env: {
          JARVIS_EVENT: event,
          JARVIS_PROJECT_DIR: this.cwd,
          ...(payload.tool_name ? { JARVIS_TOOL: payload.tool_name } : {}),
          ...(file ? { JARVIS_FILE: file } : {}),
        },
      });
      const name = `${event} hook "${h.command.length > 50 ? h.command.slice(0, 47) + '…' : h.command}"`;

      if (r.failure) {
        result.errors.push(`${name} ${r.failure}`);
        continue;
      }
      if (r.code === 2) {
        result.block = clip(r.stderr) || clip(r.stdout) || `blocked by ${name}`;
        break;
      }
      if (r.code !== 0) {
        result.errors.push(`${name} failed with exit code ${r.code}${r.stderr.trim() ? `: ${clip(r.stderr).split('\n')[0]}` : ''}`);
        continue;
      }

      // Exit 0: optional JSON for finer control, otherwise plain text.
      const out = r.stdout.trim();
      if (out.startsWith('{')) {
        try {
          const j = JSON.parse(out) as { decision?: string; reason?: string; context?: string };
          if (j.context) result.context.push(clip(j.context));
          if (j.decision === 'block') {
            result.block = clip(j.reason ?? '') || `blocked by ${name}`;
            break;
          }
          if (j.decision === 'allow') result.allow = true;
          continue;
        } catch {
          /* not JSON after all: treat as text */
        }
      }
      if (out && event === 'UserPromptSubmit') result.context.push(clip(out));
    }
    return result;
  }
}
