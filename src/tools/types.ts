import type { z } from 'zod';

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
  /**
   * absolute path → mtime when the model last Read (or wrote) it. Edit/Write refuse to touch an
   * existing file the model hasn't read, or that changed since — so it never edits a stale view.
   */
  fileState?: Map<string, number>;
  /**
   * Runs a sub-agent to completion and returns only its final report. Provided by the loop (not
   * imported by the Task tool) so tools stay free of loop/router dependencies.
   */
  runAgent?: (req: AgentRequest) => Promise<string>;
  /** Short live status lines while a long call runs (e.g. a sub-agent's tool calls). */
  onProgress?: (text: string) => void;
}

export interface AgentRequest {
  agent: AgentDef;
  prompt: string;
  onProgress?: (text: string) => void;
}

/** A sub-agent: its own system prompt, tool subset and (optionally) a cheaper model. */
export interface AgentDef {
  name: string;
  /** Model-facing: when the parent should pick this agent. */
  description: string;
  /** System prompt body (environment + JARVIS.md are added automatically). */
  prompt: string;
  /** Tool names it may use; undefined = every enabled tool except Task and TodoWrite. */
  tools?: string[];
  /** provider/model to try first; the main model chain is the fallback. */
  model?: string;
  /** Where it came from: 'built-in' or the .md file path. */
  source: string;
}

/**
 * The contract every tool implements. Kept provider-agnostic: the registry turns `schema` into
 * JSON Schema for the model; the loop validates args with the same zod schema before `run`.
 */
export interface Tool<A = any> {
  name: string;
  /** Short and model-facing. Users can override it per project via settings (see registry.ts). */
  description: string;
  schema: z.ZodType<A>;
  /**
   * JSON Schema sent to the model instead of one generated from `schema`. For tools defined
   * elsewhere (MCP servers) that already describe their args in JSON Schema.
   */
  parameters?: Record<string, unknown>;
  /** Read-only tools can run in parallel and skip the permission prompt inside the project. */
  readOnly: boolean;
  /**
   * 'ask' = never auto-allow, even when read-only. For tools whose read-only claim comes from
   * someone we don't trust (an MCP server's annotations).
   */
  defaultPermission?: 'ask';
  /** Per-call override of `readOnly`, for tools whose effect depends on the args (e.g. Task). */
  isReadOnly?(args: A): boolean;
  /**
   * 'always'   = full definition sent on every request.
   * 'deferred' = only the name is listed; the model fetches the definition when needed (later step).
   */
  loading: 'always' | 'deferred';
  /** The string permission rules match against, e.g. the command for Bash: `Bash(git status)`. */
  permissionKey(args: A): string;
  /** Filesystem paths the call touches, so the permission layer can spot access outside the project. */
  paths?(args: A, cwd: string): string[];
  /**
   * Optional dry run shown in the permission prompt (e.g. a diff). Throwing here means the call
   * can't succeed, so the loop returns the error to the model without bothering the user.
   */
  preview?(args: A, ctx: ToolContext): Promise<string>;
  /** Returns text for the model. Throwing is fine: the loop turns errors into tool results. */
  run(args: A, ctx: ToolContext): Promise<string>;
}

/** Whether this particular call is read-only (parallel-safe, no prompt inside the project). */
export function callIsReadOnly(tool: Tool, args: unknown): boolean {
  return tool.isReadOnly ? tool.isReadOnly(args) : tool.readOnly;
}
