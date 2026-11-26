import { openBrowser, startUi, type RunningUi } from '../config/ui.js';
import type { SlashCommand } from './types.js';

/** One settings server per Jarvis process; /config again just reopens it. */
let running: Promise<RunningUi> | undefined;

export const configCommand: SlashCommand = {
  name: 'config',
  aliases: ['settings'],
  description: 'open the settings page in your browser',
  run: async (_args, ctx) => {
    running ??= startUi(ctx.cwd);
    let ui: RunningUi;
    try {
      ui = await running;
    } catch (e) {
      running = undefined;
      return ctx.print(`Could not start the settings page: ${(e as Error).message}`, 'error');
    }
    openBrowser(ui.url);
    ctx.print(
      `Settings page: ${ui.url}\nIt runs while Jarvis is open, only on this computer. Changes apply from your next message (MCP servers: restart Jarvis).`,
    );
  },
};

/** Stops the server, if /config started one (called on exit). */
export async function stopConfigServer(): Promise<void> {
  const r = running;
  running = undefined;
  await r?.then((ui) => ui.close()).catch(() => {});
}
