import type { Settings } from '../config/settings.js';
import { isInside } from '../tools/fsutil.js';
import { callIsReadOnly, type Tool } from '../tools/types.js';

export type Decision = 'allow' | 'deny' | 'ask';

interface Rule {
  tool: string;
  /** undefined = matches every call of the tool. */
  spec?: string;
}

/** "Bash(git status)" → { tool: 'Bash', spec: 'git status' };  "Read" → { tool: 'Read' } */
export function parseRule(rule: string): Rule {
  const m = /^([A-Za-z0-9_]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) throw new Error(`Bad permission rule: "${rule}"`);
  return { tool: m[1]!, spec: m[2] };
}

/** Spec matching: exact, or "prefix:*" (e.g. "npm test:*" matches "npm test -- --watch"). */
export function ruleMatches(rule: string, toolName: string, key: string): boolean {
  const r = parseRule(rule);
  if (r.tool.toLowerCase() !== toolName.toLowerCase()) return false;
  if (r.spec === undefined || r.spec === '*') return true;
  if (r.spec.endsWith(':*')) return key.startsWith(r.spec.slice(0, -2));
  return key === r.spec;
}

/**
 * Decides whether a call may run without asking.
 * Order matters: deny rules always win, then allow rules (settings + "always allow" answers from
 * this session), then the default: read-only tools inside the project are allowed, everything
 * else asks.
 */
export function checkPermission(
  tool: Tool,
  args: unknown,
  ctx: { cwd: string; settings: Settings; sessionAllow: string[] },
): Decision {
  const key = tool.permissionKey(args);
  const deny = ctx.settings.permissions?.deny ?? [];
  const allow = [...(ctx.settings.permissions?.allow ?? []), ...ctx.sessionAllow];
  if (deny.some((r) => ruleMatches(r, tool.name, key))) return 'deny';
  if (allow.some((r) => ruleMatches(r, tool.name, key))) return 'allow';
  if (callIsReadOnly(tool, args)) {
    const paths = tool.paths?.(args, ctx.cwd) ?? [];
    return paths.every((p) => isInside(ctx.cwd, p)) ? 'allow' : 'ask';
  }
  return 'ask';
}
