import type { ModelMessage } from 'ai';

/**
 * Our own message format. Only this file knows the SDK's format, so the rest of the app (UI,
 * sessions, compaction) doesn't change when we swap SDKs or add providers.
 */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string; isError?: boolean };

export function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    switch (m.role) {
      case 'user':
        return { role: 'user', content: m.content };
      case 'assistant':
        if (!m.toolCalls?.length) return { role: 'assistant', content: m.content };
        return {
          role: 'assistant',
          content: [
            ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
            ...m.toolCalls.map((c) => ({
              type: 'tool-call' as const,
              toolCallId: c.id,
              toolName: c.name,
              input: c.args,
            })),
          ],
        };
      case 'tool':
        return {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: m.toolCallId,
              toolName: m.toolName,
              // Plain text even for errors: every OpenAI-compatible server understands it.
              output: { type: 'text', value: m.isError ? `Error: ${m.content}` : m.content },
            },
          ],
        };
    }
  });
}
