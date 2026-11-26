import { z } from 'zod';
import type { Message } from '../core/messages.js';
import type { Tool } from './types.js';

const todo = z.object({
  content: z.string().min(1).describe('The step, imperative, e.g. "Add tests for the parser"'),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

const schema = z.object({
  todos: z.array(todo).describe('The complete list, every time (it replaces the previous one)'),
});

export type Todo = z.infer<typeof todo>;

/**
 * TodoWrite: a checklist the model keeps for multi-step work. It has no side effects; the value is
 * that (1) the user sees the plan and progress, and (2) the model re-reads its own plan in the
 * history, which keeps small models from losing track halfway through a long task.
 *
 * There's no hidden store: the list *is* the latest call's arguments, so it survives resume and
 * compaction-free sessions without extra state (see latestTodos).
 */
export const TodoWriteTool: Tool<z.infer<typeof schema>> = {
  name: 'TodoWrite',
  description:
    'Keep a visible checklist for tasks with 3+ steps. Send the full list each time. Mark a step in_progress before starting it and completed as soon as it is done; keep only one in_progress. Skip it for simple one-step requests.',
  schema,
  readOnly: true,
  loading: 'always',
  permissionKey: (a) => `${a.todos.length} items`,
  async run(a) {
    const done = a.todos.filter((t) => t.status === 'completed').length;
    const active = a.todos.filter((t) => t.status === 'in_progress').length;
    const note = active > 1 ? ' Note: more than one item is in_progress; finish one before starting the next.' : '';
    return `Todo list updated (${done}/${a.todos.length} completed).${note}`;
  },
};

const MARK: Record<Todo['status'], string> = { pending: '☐', in_progress: '◐', completed: '☑' };

export function formatTodos(todos: Todo[]): string {
  if (todos.length === 0) return '(empty todo list)';
  return todos.map((t) => `${MARK[t.status]} ${t.content}`).join('\n');
}

/** The current list = arguments of the last successful TodoWrite call in the history. */
export function latestTodos(messages: Message[]): Todo[] | undefined {
  const failed = new Set<string>();
  for (const m of messages) if (m.role === 'tool' && m.isError) failed.add(m.toolCallId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (let j = m.toolCalls.length - 1; j >= 0; j--) {
      const c = m.toolCalls[j]!;
      if (c.name !== 'TodoWrite' || failed.has(c.id)) continue;
      const parsed = schema.safeParse(c.args);
      if (parsed.success) return parsed.data.todos;
    }
  }
  return undefined;
}
