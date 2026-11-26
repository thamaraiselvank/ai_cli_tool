import { jsonSchema, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Settings } from '../config/settings.js';
import { BashTool } from './bash.js';
import { EditTool } from './edit.js';
import { GlobTool } from './glob.js';
import { GrepTool } from './grep.js';
import { loadAgents } from '../agents/index.js';
import { ReadTool } from './read.js';
import { createTaskTool, TaskTool } from './task.js';
import { TodoWriteTool } from './todo.js';
import { callIsReadOnly, type Tool } from './types.js';
import { WriteTool } from './write.js';

/** Every built-in tool. Adding a tool = write tools/<name>.ts and list it here. */
export const BUILTIN_TOOLS: Tool[] = [ReadTool, GlobTool, GrepTool, EditTool, WriteTool, BashTool, TodoWriteTool, TaskTool];

export interface ToolStatus {
  tool: Tool;
  enabled: boolean;
  descriptionOverridden: boolean;
}

/** All built-ins with the user's settings applied (enabled flag + description override). */
export function toolStatuses(settings: Settings): ToolStatus[] {
  const disabled = new Set(settings.tools?.disabled ?? []);
  const overrides = settings.tools?.descriptions ?? {};
  return BUILTIN_TOOLS.map((t) => {
    const desc = overrides[t.name];
    return {
      tool: desc ? { ...t, description: desc } : t,
      enabled: !disabled.has(t.name),
      descriptionOverridden: Boolean(desc),
    };
  });
}

/**
 * Enabled tools for a run. With `cwd`, Task is rebuilt so its description lists the project's own
 * agents (.jarvis/agents/) too; without it, Task only knows the built-in agents.
 */
export function activeTools(settings: Settings, cwd?: string): Tool[] {
  const tools = toolStatuses(settings).filter((s) => s.enabled).map((s) => s.tool);
  if (cwd === undefined) return tools;
  return tools.map((t) => {
    if (t.name !== 'Task') return t;
    const task = createTaskTool({
      agents: loadAgents(cwd).agents,
      enabledTools: tools.map((x) => x.name),
      readOnlyTools: new Set(tools.filter((x) => x.name !== 'Task' && callIsReadOnly(x, {})).map((x) => x.name)),
    });
    // Keep a user's description override if they set one.
    return settings.tools?.descriptions?.Task ? { ...task, description: t.description } : task;
  });
}

export function findTool(name: string): Tool | undefined {
  return BUILTIN_TOOLS.find((t) => t.name.toLowerCase() === name.toLowerCase());
}

/** The JSON Schema the model sees for a tool's arguments. `$schema` is dropped: wasted tokens. */
export function toolParameters(tool: Tool): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  return rest;
}

/**
 * Tool definitions in the AI SDK's format. No `execute` functions: we want the SDK to only *report*
 * tool calls, so our own loop controls permissions, validation, parallelism and output caps.
 * The SDK schema has no validator on purpose — validation happens in the loop with zod, so bad
 * args become a readable error the model can fix instead of an SDK exception.
 */
export function toSdkTools(tools: Tool[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools.filter((t) => t.loading === 'always')) {
    set[t.name] = { description: t.description, inputSchema: jsonSchema(toolParameters(t) as any) };
  }
  return set;
}

/** Rough token cost of one tool definition (chars / 4; real tokenizer comes in step 5). */
export function estimateToolTokens(tool: Tool): number {
  const json = JSON.stringify({ name: tool.name, description: tool.description, parameters: toolParameters(tool) });
  return Math.ceil(json.length / 4);
}
