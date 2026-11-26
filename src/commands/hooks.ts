import { isTrusted, trustProject, untrustedCommands } from '../config/trust.js';
import { HOOK_EVENTS, loadHooks } from '../hooks/index.js';
import type { SlashCommand } from './types.js';

export const HOOKS_HELP = `Add hooks under "hooks" in a settings file, e.g. .jarvis/settings.json:
  "hooks": {
    "PostToolUse": [{ "matcher": "Edit|Write", "command": "npx prettier --write \\"$env:JARVIS_FILE\\"" }],
    "PreToolUse":  [{ "matcher": "Bash", "command": "node scripts/guard.js" }],
    "Stop":        [{ "command": "npm test --silent", "timeout": 300 }]
  }
Events: ${HOOK_EVENTS.join(', ')}. matcher = regex on the tool name (tool events only).
Input: JSON on stdin; env JARVIS_EVENT, JARVIS_TOOL, JARVIS_FILE, JARVIS_PROJECT_DIR
       (PowerShell: $env:JARVIS_FILE, sh: "$JARVIS_FILE").
Exit 0 = ok · exit 2 = block (PreToolUse/UserPromptSubmit), feedback to the model (PostToolUse),
or keep working (Stop), with stderr as the reason · other codes = broken hook, shown to you.`;

/** One line for startup when this folder's settings want to run commands we're ignoring. */
export function untrustedNotice(cwd: string): string | undefined {
  if (isTrusted(cwd)) return undefined;
  const u = untrustedCommands(cwd);
  const parts = [
    u.hooks ? `${u.hooks} hook${u.hooks === 1 ? '' : 's'}` : '',
    u.mcpServers.length ? `MCP server${u.mcpServers.length === 1 ? '' : 's'} ${u.mcpServers.join(', ')}` : '',
  ].filter(Boolean);
  if (!parts.length) return undefined;
  return `This folder's .jarvis settings define ${parts.join(' and ')}, which run commands on their own. They're ignored until you trust this folder: /trust (or jarvis trust).`;
}

export const hooksCommand: SlashCommand = {
  name: 'hooks',
  description: 'list hooks (commands run at tool use, prompt submit, stop)',
  run: (_args, ctx) => {
    const { hooks, errors } = loadHooks(ctx.cwd);
    const rows = hooks.map((h) => `${h.event.padEnd(17)} ${(h.matcher ?? '*').padEnd(14)} ${h.command}\n${' '.repeat(18)}from ${h.source}`);
    const notice = untrustedNotice(ctx.cwd);
    ctx.print(
      [
        ...(rows.length ? rows : ['No hooks configured.']),
        ...errors.map((e) => `Problem: ${e}`),
        ...(notice ? ['', notice] : []),
        '',
        HOOKS_HELP,
        'Hooks are re-read on every message.',
      ].join('\n'),
      errors.length ? 'error' : 'info',
    );
  },
};

export const trustCommand: SlashCommand = {
  name: 'trust',
  description: "trust this folder's .jarvis settings to run hooks and MCP servers",
  run: (_args, ctx) => {
    if (isTrusted(ctx.cwd)) return ctx.print('This folder is already trusted.');
    const file = trustProject(ctx.cwd);
    ctx.print(`Trusted ${ctx.cwd} (saved in ${file}). Hooks apply from the next message; restart Jarvis to start its MCP servers.`);
  },
};
