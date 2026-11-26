import type { Message } from '../core/messages.js';
import type { Session } from '../core/session.js';
import type { McpManager } from '../mcp/client.js';
import type { Router } from '../providers/router.js';
import type { UI } from '../ui/dialogs.js';

/** The current conversation, as commands may see and change it. */
export interface Conversation {
  /** The live history array (commands like /compact edit it in place). */
  messages(): Message[];
  session(): Session;
  system: string;
  /** Start fresh: empty history, new session file (/clear). */
  startNew(): void;
  /** Switch to another saved conversation (/resume). */
  load(messages: Message[], session: Session): void;
}

/** What a slash command can do. Deliberately small, so commands stay testable without Ink. */
export interface CommandContext {
  cwd: string;
  router: Router;
  /** Live MCP connections, if any servers are configured. */
  mcp?: McpManager;
  ui: UI;
  conversation: Conversation;
  print(text: string, kind?: 'info' | 'error'): void;
  /** Report how full the context is (updates the status bar). */
  setContextUsage?(used: number, limit: number): void;
  exit(): void;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  /** Shown in /help and the autocomplete menu, e.g. "[provider/model]". */
  args?: string;
  description: string;
  run(args: string[], ctx: CommandContext): void | Promise<void>;
}
