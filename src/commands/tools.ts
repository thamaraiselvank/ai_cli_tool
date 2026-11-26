import { loadSettings, updateSettings, type SettingsScope } from '../config/settings.js';
import { estimateToolTokens, findTool, toolParameters, toolStatuses } from '../tools/registry.js';

export const TOOLS_HELP = `Usage: tools [list]                      show tools, status and token cost
       tools show <name>                full definition as sent to the model
       tools enable|disable <name>      turn a tool on/off
       tools describe <name> <text>     replace the model-facing description
       tools reset <name>               restore the built-in description
Add --global (all projects) or --local (just you, gitignored). Default: project .jarvis/settings.json`;

/**
 * One implementation for both `jarvis tools …` (terminal) and `/tools …` (inside the chat).
 * Returns text to print; throws on bad input.
 */
export function runToolsCommand(argv: string[], cwd = process.cwd()): string {
  const scope: SettingsScope = argv.includes('--global') ? 'global' : argv.includes('--local') ? 'local' : 'project';
  const args = argv.filter((a) => a !== '--global' && a !== '--local');
  const [sub = 'list', name, ...rest] = args;

  if (sub === 'list') return listTools(cwd);
  if (sub === 'help') return TOOLS_HELP;

  if (!name) throw new Error(`Missing tool name.\n${TOOLS_HELP}`);
  const tool = findTool(name);
  if (!tool) throw new Error(`Unknown tool "${name}". Run "tools list".`);

  switch (sub) {
    case 'show': {
      const status = toolStatuses(loadSettings(cwd)).find((s) => s.tool.name === tool.name)!;
      return JSON.stringify(
        { name: tool.name, description: status.tool.description, parameters: toolParameters(tool) },
        null,
        2,
      );
    }
    case 'enable':
    case 'disable': {
      const file = updateSettings(scope, (s) => {
        const set = new Set(s.tools?.disabled ?? []);
        if (sub === 'disable') set.add(tool.name);
        else set.delete(tool.name);
        s.tools = { ...s.tools, disabled: [...set] };
      }, cwd);
      const note =
        sub === 'enable' && toolStatuses(loadSettings(cwd)).find((s) => s.tool.name === tool.name)?.enabled === false
          ? `\nNote: still disabled by another settings file (disabled lists are merged across files).`
          : '';
      return `${tool.name} ${sub}d in ${file}${note}`;
    }
    case 'describe': {
      const text = rest.join(' ').trim();
      if (!text) throw new Error('Give the new description text.');
      const file = updateSettings(scope, (s) => {
        s.tools = { ...s.tools, descriptions: { ...s.tools?.descriptions, [tool.name]: text } };
      }, cwd);
      return `${tool.name} description updated in ${file}`;
    }
    case 'reset': {
      const file = updateSettings(scope, (s) => {
        const d = { ...s.tools?.descriptions };
        delete d[tool.name];
        s.tools = { ...s.tools, descriptions: d };
      }, cwd);
      return `${tool.name} description reset in ${file}`;
    }
    default:
      throw new Error(`Unknown subcommand "${sub}".\n${TOOLS_HELP}`);
  }
}

function listTools(cwd: string): string {
  const statuses = toolStatuses(loadSettings(cwd));
  let total = 0;
  const rows = statuses.map(({ tool, enabled, descriptionOverridden }) => {
    const tokens = estimateToolTokens(tool);
    if (enabled && tool.loading === 'always') total += tokens;
    return [
      enabled ? 'on ' : 'off',
      tool.name.padEnd(6),
      (tool.readOnly ? 'read-only' : 'asks').padEnd(9),
      tool.loading.padEnd(8),
      `~${tokens} tok`.padEnd(9),
      (descriptionOverridden ? '* ' : '') + tool.description,
    ].join('  ');
  });
  return [
    ...rows,
    '',
    `Sent with every request: ~${total} tokens of tool definitions.  (* = custom description)`,
    `Edit with: tools enable|disable|describe|reset <name>   ·   tools help`,
  ].join('\n');
}
