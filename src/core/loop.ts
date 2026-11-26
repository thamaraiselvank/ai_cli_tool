import type { Settings } from '../config/settings.js';
import { checkPermission } from '../permissions/index.js';
import type { Router } from '../providers/router.js';
import { agentToolNames } from '../agents/index.js';
import type { HookResult, HookRunner } from '../hooks/index.js';
import { estimateToolTokens, toSdkTools } from '../tools/registry.js';
import { callIsReadOnly, type AgentRequest, type Tool } from '../tools/types.js';
import { isContextOverflow, manageContext, type ManageOptions } from './context.js';
import type { Message, ToolCall } from './messages.js';
import type { Session } from './session.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { capOutput, DEFAULT_LIMITS } from './truncate.js';

export type PermissionAnswer = 'allow' | 'always' | 'deny';

export type LoopEvent =
  | { type: 'text'; text: string }
  /** `display` = permission key plus the other args, e.g. `tool, glob=**\/*.ts` */
  | { type: 'tool-call'; call: ToolCall; key: string; display: string; preview?: string }
  | { type: 'tool-result'; call: ToolCall; output: string; isError: boolean }
  /** Live status from a running call, e.g. a sub-agent's own tool calls. */
  | { type: 'progress'; call: ToolCall; text: string }
  | { type: 'notice'; text: string }
  | { type: 'context'; used: number; limit: number };

export interface LoopOptions {
  /** Owns model choice, fallbacks and rate limits; long-lived so limits/usage span turns. */
  router: Router;
  system: string;
  tools: Tool[];
  settings: Settings;
  cwd: string;
  abortSignal?: AbortSignal;
  /** Safety net against a model that never stops calling tools. */
  maxSteps?: number;
  /** Called when a call needs approval. Headless mode answers automatically. */
  askPermission: (call: ToolCall, tool: Tool, key: string, preview?: string) => Promise<PermissionAnswer>;
  /** "Always allow" answers for this session; shared across turns by the caller. */
  sessionAllow: string[];
  /** Which files the model has read (see ToolContext.fileState); shared across turns by the caller. */
  fileState: Map<string, number>;
  /** Where the transcript is saved. Optional so tests and throwaway runs can skip it. */
  session?: Session;
  /** Model chain override for every request of this loop (sub-agents). */
  models?: string[];
  /** User hooks (see hooks/index.ts). Tool hooks also apply inside sub-agents. */
  hooks?: HookRunner;
  /** Sub-agents skip UserPromptSubmit and Stop hooks: those are about the user's conversation. */
  isSubagent?: boolean;
}

/** How often a Stop hook may send the model back to work in one turn (guards against loops). */
const MAX_STOP_CONTINUES = 3;

interface Prepared {
  call: ToolCall;
  tool?: Tool;
  args?: unknown;
  /** Set when the call must not run: unknown tool, bad args, or permission denied. */
  error?: string;
}

/**
 * The agentic loop: send history + tools → stream the reply → if the model asked for tools, run
 * them, append the results, and go again. Stops when a reply has no tool calls.
 *
 * `messages` is appended to in place (assistant replies and tool results), so the caller's history
 * stays complete. UI-free: it only yields events, so the TUI and headless mode share it.
 */
export async function* runLoop(messages: Message[], opts: LoopOptions): AsyncGenerator<LoopEvent> {
  const maxSteps = opts.maxSteps ?? 25;
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const limits = {
    maxLines: opts.settings.context?.maxToolOutputLines ?? DEFAULT_LIMITS.maxLines,
    maxBytes: opts.settings.context?.maxToolOutputBytes ?? DEFAULT_LIMITS.maxBytes,
  };

  const sdkTools = toSdkTools(opts.tools);
  const manage: ManageOptions = {
    router: opts.router,
    settings: opts.settings,
    system: opts.system,
    toolTokens: opts.tools.filter((t) => t.loading === 'always').reduce((n, t) => n + estimateToolTokens(t), 0),
    session: opts.session,
    abortSignal: opts.abortSignal,
    model: opts.models?.[0],
  };
  const runAgent = makeAgentRunner(opts);
  const hooks = opts.hooks;
  const topLevel = !opts.isSubagent;

  // ---- UserPromptSubmit hooks: may block the prompt or attach context to it ------------------
  const prompt = messages.at(-1);
  if (hooks && topLevel && prompt?.role === 'user' && hooks.has('UserPromptSubmit')) {
    const r = await hooks.run('UserPromptSubmit', { prompt: prompt.content }, opts.abortSignal);
    yield* hookErrors(r);
    if (r.block) {
      messages.pop(); // never reaches the model or the transcript
      yield { type: 'notice', text: `Prompt blocked by a hook: ${r.block}` };
      return;
    }
    if (r.context.length) prompt.content += `\n\n<hook-context>\n${r.context.join('\n\n')}\n</hook-context>`;
  }
  opts.session?.sync(messages); // the user's new message
  let stopContinues = 0;

  for (let step = 0; step < maxSteps; step++) {
    // ---- 0. Keep the request under the model's limit (clear old tool output / compact) --------
    yield* manageContext(messages, manage);

    // ---- 1. One model call, via the router (rate limits, retries, fallbacks) ------------------
    // `yield*` forwards the router's text/notice events straight to our caller.
    let response;
    try {
      response = yield* opts.router.call({ system: opts.system, messages, tools: sdkTools, abortSignal: opts.abortSignal, models: opts.models });
    } catch (e) {
      // Our token count is an estimate; if the provider still says "too large", compact for real
      // and retry once.
      if (!isContextOverflow(e) || opts.abortSignal?.aborted) throw e;
      yield { type: 'notice', text: 'The provider says the request is too large. Compacting and retrying…' };
      yield* manageContext(messages, manage, { compact: true });
      response = yield* opts.router.call({ system: opts.system, messages, tools: sdkTools, abortSignal: opts.abortSignal, models: opts.models });
    }
    const { text, toolCalls: calls } = response;
    messages.push({ role: 'assistant', content: text, toolCalls: calls.length ? calls : undefined });
    opts.session?.sync(messages);
    if (calls.length === 0) {
      // ---- Stop hooks: a guaranteed check before we hand back (e.g. "do the tests pass?") ----
      if (!hooks || !topLevel || !hooks.has('Stop') || opts.abortSignal?.aborted) return;
      const r = await hooks.run('Stop', { last_message: text }, opts.abortSignal);
      yield* hookErrors(r);
      if (!r.block) return;
      if (stopContinues >= MAX_STOP_CONTINUES) {
        yield { type: 'notice', text: `A Stop hook still objects after ${MAX_STOP_CONTINUES} retries; stopping. Last reason: ${r.block}` };
        return;
      }
      stopContinues++;
      yield { type: 'notice', text: `Stop hook: ${r.block.split('\n')[0]} — continuing (${stopContinues}/${MAX_STOP_CONTINUES})` };
      messages.push({ role: 'user', content: `[A Stop hook objected; fix this before finishing]\n${r.block}` });
      opts.session?.sync(messages);
      continue;
    }

    // ---- 2. Validate + permission-check every call (sequentially: prompts must not overlap) ----
    const prepared: Prepared[] = [];
    for (const call of calls) {
      const tool = byName.get(call.name);
      if (!tool) {
        prepared.push({ call, error: `Unknown tool "${call.name}". Available: ${[...byName.keys()].join(', ')}` });
        continue;
      }
      // Small models often send wrong/missing args. Returning zod's message lets them self-correct.
      const parsed = tool.schema.safeParse(call.args);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
        prepared.push({ call, tool, error: `Invalid arguments for ${tool.name}: ${issues.join('; ')}` });
        continue;
      }
      const key = tool.permissionKey(parsed.data);

      // Dry run (e.g. Edit's diff). If it fails, the real run would fail too: report it to the
      // model now instead of asking the user to approve a doomed call.
      let preview: string | undefined;
      if (tool.preview) {
        try {
          preview = await tool.preview(parsed.data, { cwd: opts.cwd, fileState: opts.fileState });
        } catch (e) {
          yield { type: 'tool-call', call, key, display: describeCall(key, parsed.data) };
          prepared.push({ call, tool, error: (e as Error).message });
          continue;
        }
      }
      yield { type: 'tool-call', call, key, display: describeCall(key, parsed.data), preview };

      // PreToolUse hooks run before the permission check: a hook's "no" needs no prompt, and its
      // "yes" may replace the prompt (but never beats a deny rule).
      let hookAllow = false;
      if (hooks?.has('PreToolUse', tool.name)) {
        const r = await hooks.run('PreToolUse', { tool_name: tool.name, tool_input: parsed.data }, opts.abortSignal);
        yield* hookErrors(r);
        if (r.block) {
          prepared.push({ call, tool, error: `Blocked by a PreToolUse hook: ${r.block}` });
          continue;
        }
        hookAllow = Boolean(r.allow);
      }

      let decision = checkPermission(tool, parsed.data, opts);
      let denial = 'Blocked by a deny rule in the user\'s settings.';
      if (decision === 'ask' && hookAllow) decision = 'allow';
      if (decision === 'ask') {
        const answer = await opts.askPermission(call, tool, key, preview);
        if (answer === 'always') opts.sessionAllow.push(`${tool.name}(${key})`);
        decision = answer === 'deny' ? 'deny' : 'allow';
        denial = 'Permission denied by the user.';
      }
      prepared.push(decision === 'deny' ? { call, tool, error: denial } : { call, tool, args: parsed.data });
    }

    // ---- 3. Execute: read-only calls in parallel batches, mutating calls one at a time --------
    // Why: reads can't interfere with each other, but a Bash command may depend on (or break)
    // the state another one leaves behind.
    let i = 0;
    while (i < prepared.length) {
      const batch: Prepared[] = [prepared[i]!];
      if (isParallel(prepared[i]!)) {
        while (i + batch.length < prepared.length && isParallel(prepared[i + batch.length]!)) {
          batch.push(prepared[i + batch.length]!);
        }
      }
      i += batch.length;

      // Run the batch, yielding progress events while it's going. A generator can't yield from
      // inside a callback, so tools push into a queue and we wake up whenever something arrives.
      const queue: LoopEvent[] = [];
      let wake: (() => void) | undefined;
      let settled = false;
      const all = Promise.all(
        batch.map((p) =>
          execute(p, opts, limits, runAgent, (text) => {
            queue.push({ type: 'progress', call: p.call, text });
            wake?.();
          }),
        ),
      ).finally(() => {
        settled = true;
        wake?.();
      });
      while (!settled || queue.length) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = undefined;
        while (queue.length) yield queue.shift()!;
      }
      const outputs = await all;
      for (const [j, p] of batch.entries()) {
        const out = outputs[j]!;
        // PostToolUse hooks: only for calls that actually ran. Exit 2 = feedback for the model
        // (e.g. formatter/linter complaints), attached to the result it relates to.
        if (hooks && p.tool && !p.error && hooks.has('PostToolUse', p.tool.name)) {
          const r = await hooks.run(
            'PostToolUse',
            { tool_name: p.tool.name, tool_input: p.args, tool_output: out.output, is_error: out.isError },
            opts.abortSignal,
          );
          yield* hookErrors(r);
          const feedback = [r.block, ...r.context].filter(Boolean).join('\n\n');
          if (feedback) out.output += `\n\n[PostToolUse hook feedback]\n${feedback}`;
        }
        messages.push({ role: 'tool', toolCallId: p.call.id, toolName: p.call.name, content: out.output, isError: out.isError });
        yield { type: 'tool-result', call: p.call, ...out };
      }
    }
    opts.session?.sync(messages);

    if (opts.abortSignal?.aborted) return;
  }
  yield { type: 'notice', text: `Stopped after ${maxSteps} steps. Send a message to continue.` };
}

/** A broken hook is the user's problem to fix, not the model's: surface it as a notice. */
function* hookErrors(r: HookResult): Generator<LoopEvent> {
  for (const text of r.errors) yield { type: 'notice', text: `Hook problem: ${text}` };
}

/** "tool, glob=**\/*.ts" — the key first, then any other args that aren't the key itself. */
function describeCall(key: string, args: unknown): string {
  const extras = Object.entries((args ?? {}) as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== '' && v !== key)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      // Edit/Write contents would flood the screen; the diff preview shows them properly.
      return `${k}=${s.length > 60 || s.includes('\n') ? `<${s.split('\n').length} lines>` : s}`;
    });
  return [key, ...extras].filter(Boolean).join(', ');
}

/** Errors (no tool) are trivially parallel-safe; otherwise ask the tool about this call. */
function isParallel(p: Prepared): boolean {
  return !p.tool || p.error !== undefined || callIsReadOnly(p.tool, p.args);
}

async function execute(
  p: Prepared,
  opts: LoopOptions,
  limits: { maxLines: number; maxBytes: number },
  runAgent: (req: AgentRequest) => Promise<string>,
  onProgress: (text: string) => void,
): Promise<{ output: string; isError: boolean }> {
  if (p.error || !p.tool) return { output: p.error ?? 'Unknown error', isError: true };
  try {
    const out = await p.tool.run(p.args, {
      cwd: opts.cwd,
      abortSignal: opts.abortSignal,
      fileState: opts.fileState,
      runAgent,
      onProgress,
    });
    return { output: capOutput(out, limits), isError: false };
  } catch (e) {
    // Tool failures go back to the model as results — never thrown out of the loop.
    return { output: capOutput((e as Error).message, limits), isError: true };
  }
}

/**
 * Builds the function the Task tool calls. A sub-agent is just another runLoop with:
 *  - its own fresh history (only the task prompt) — the isolation that keeps the parent small,
 *  - its own system prompt and tool subset, optionally a cheaper model first in the chain,
 *  - the same router (shared rate limits/usage), permissions and "always allow" answers,
 *  - its own fileState: the parent hasn't seen what the child read, so it must Read before editing.
 * Only the child's last message comes back; its tool calls surface as progress lines.
 */
function makeAgentRunner(parent: LoopOptions): (req: AgentRequest) => Promise<string> {
  // Parallel read-only agents may each need a prompt (e.g. a Read outside the project). The UI
  // shows one prompt at a time, so queue them.
  let lastPrompt: Promise<unknown> = Promise.resolve();
  const askPermission: LoopOptions['askPermission'] = (...args) => {
    const answer = lastPrompt.then(() => parent.askPermission(...args));
    lastPrompt = answer.catch(() => undefined);
    return answer;
  };

  return async ({ agent, prompt, onProgress }) => {
    const settings = parent.settings;
    const names = new Set(agentToolNames(agent, parent.tools.map((t) => t.name)));
    const model = agent.model ?? settings.agents?.model;
    const chain = parent.models ?? parent.router.chain;
    const messages: Message[] = [{ role: 'user', content: prompt }];
    let steps = 0;

    for await (const ev of runLoop(messages, {
      router: parent.router,
      system: buildSystemPrompt(parent.cwd, { base: agent.prompt }),
      tools: parent.tools.filter((t) => names.has(t.name)),
      settings,
      cwd: parent.cwd,
      abortSignal: parent.abortSignal,
      maxSteps: settings.agents?.maxSteps ?? 30,
      askPermission,
      sessionAllow: parent.sessionAllow,
      fileState: new Map(),
      models: model ? [model, ...chain] : parent.models,
      // Guards like "never touch .env" must hold inside sub-agents too.
      hooks: parent.hooks,
      isSubagent: true,
    })) {
      if (ev.type === 'tool-call') {
        steps++;
        onProgress?.(`${ev.call.name}(${ev.display})`);
      } else if (ev.type === 'progress') onProgress?.(ev.text);
      else if (ev.type === 'notice') onProgress?.(ev.text);
      // 'text' is the child's own reply (returned below); 'context' would confuse the parent's gauge.
    }
    if (parent.abortSignal?.aborted) throw new Error('Interrupted.');

    const last = messages.at(-1);
    // Normally the final message is the report. After a step limit it's a tool result, so fall
    // back to the latest thing the agent said.
    const said = messages.findLast((m) => m.role === 'assistant' && m.content.trim());
    const report = said?.content.trim() ?? '';
    const unfinished = last?.role !== 'assistant' || Boolean(last.toolCalls?.length);
    if (!report) return `The ${agent.name} agent stopped after ${steps} tool calls without a report.`;
    return unfinished ? `${report}\n\n[The ${agent.name} agent hit its step limit before finishing.]` : report;
  };
}
