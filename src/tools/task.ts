import { z } from 'zod';
import { agentToolNames, BUILTIN_AGENTS, findAgent } from '../agents/index.js';
import type { AgentDef, Tool } from './types.js';

const schema = z.object({
  agent: z.string().describe('Which sub-agent to run (see the list in the description)'),
  description: z.string().describe('3-6 word summary shown to the user, e.g. "Find auth middleware"'),
  prompt: z
    .string()
    .min(1)
    .describe('The full task. The sub-agent sees nothing of this conversation, so include every detail it needs.'),
});

export type TaskArgs = z.infer<typeof schema>;

export interface TaskToolOptions {
  agents: AgentDef[];
  /** Enabled tool names, so the call knows which tools the agent would really get. */
  enabledTools: string[];
  /** Names of read-only tools. An agent using only these is safe to run in parallel, unprompted. */
  readOnlyTools: Set<string>;
}

/**
 * Task: hand a job to a sub-agent and get back only its report. Built by a factory because the
 * description lists the available agents, which depend on the project (.jarvis/agents/).
 */
export function createTaskTool(o: TaskToolOptions): Tool<TaskArgs> {
  const list = o.agents.map((a) => `- ${a.name}: ${a.description}`).join('\n');
  const isReadOnlyAgent = (a: AgentDef) => agentToolNames(a, o.enabledTools).every((n) => o.readOnlyTools.has(n));

  return {
    name: 'Task',
    description: `Delegate a task to a sub-agent that works in its own context and returns only a final report. Use it for broad searches or self-contained subtasks, so their intermediate output doesn't fill this conversation. Independent read-only tasks can run in parallel (several Task calls in one turn). Not for simple lookups: one Grep or Read is cheaper.\nAgents:\n${list}`,
    schema,
    readOnly: false,
    // Read-only agents (e.g. explore) run unprompted and in parallel. Others ask once for the Task;
    // their individual edits/commands are still permission-checked inside the sub-agent.
    isReadOnly: (a) => {
      const agent = findAgent(o.agents, a.agent);
      return agent ? isReadOnlyAgent(agent) : true;
    },
    loading: 'always',
    permissionKey: (a) => a.agent,
    // Not a diff: just a cheap check so an unknown agent fails before any permission prompt.
    async preview(a) {
      if (!findAgent(o.agents, a.agent)) throw new Error(unknownAgent(a.agent, o.agents));
      return '';
    },
    async run(a, ctx) {
      const agent = findAgent(o.agents, a.agent);
      if (!agent) throw new Error(unknownAgent(a.agent, o.agents));
      if (!ctx.runAgent) throw new Error('Sub-agents are not available here.');
      return ctx.runAgent({ agent, prompt: a.prompt, onProgress: ctx.onProgress });
    },
  };
}

function unknownAgent(name: string, agents: AgentDef[]): string {
  return `Unknown agent "${name}". Available: ${agents.map((a) => a.name).join(', ')}`;
}

/** Static instance for listings (`jarvis tools`); the loop gets one built with the project's agents. */
export const TaskTool = createTaskTool({
  agents: BUILTIN_AGENTS,
  enabledTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
  readOnlyTools: new Set(['Read', 'Glob', 'Grep']),
});
