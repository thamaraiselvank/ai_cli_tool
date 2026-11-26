import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDef } from '../tools/types.js';

/**
 * Sub-agents. Why have them at all: a broad search ("where is auth handled?") can take a dozen
 * Grep/Read calls whose raw output would sit in the main conversation forever. A sub-agent does
 * that work in its own, throwaway context and hands back a short report, so the parent's context
 * only grows by the report. It can also run on a cheaper/faster model than the main one.
 *
 * Built-ins live here in code (so the npm bundle needs no extra files). Users add their own as
 * markdown with frontmatter in ~/.jarvis/agents/*.md (personal) or .jarvis/agents/*.md (project);
 * a later source with the same name overrides an earlier one.
 */

const REPORT_RULES = `You are a sub-agent: the agent that called you sees only your final message, not your tool calls. End with a self-contained report: what you found or did, with file paths as path:line. Don't ask questions; nobody can answer them. If you can't finish, say what is missing.`;

export const BUILTIN_AGENTS: AgentDef[] = [
  {
    name: 'explore',
    description:
      'Read-only codebase search. Use for questions that need several searches ("where is X handled?", "how does Y work?"). Returns findings with path:line.',
    prompt: `You are a code search specialist. Answer the question by searching the project with Glob and Grep, then Read only the relevant line ranges. Be thorough but quick: run independent searches together. Report the answer and the key locations; quote only the few lines that matter.\n\n${REPORT_RULES}`,
    tools: ['Read', 'Glob', 'Grep'],
    source: 'built-in',
  },
  {
    name: 'general',
    description:
      'General-purpose agent with all tools (edits and commands ask for permission as usual). Use for a self-contained multi-step task you can describe fully.',
    prompt: `You are a capable coding agent working on one delegated task. Inspect before you change anything, keep changes minimal, and verify them (e.g. run the relevant test) when you can.\n\n${REPORT_RULES}`,
    source: 'built-in',
  },
];

const NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Folders searched for agent files, lowest priority first. */
export function agentDirs(cwd: string): string[] {
  return [path.join(os.homedir(), '.jarvis', 'agents'), path.join(cwd, '.jarvis', 'agents')];
}

/**
 * Minimal frontmatter: `key: value` lines between `---` fences. Lists may be "a, b" or "[a, b]".
 * Hand-rolled rather than a YAML dependency because agent files only need flat string fields.
 */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text.trim() };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) data[kv[1]!.toLowerCase()] = kv[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return { data, body: m[2]!.trim() };
}

function parseList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const items = v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean);
  return items.length ? items : undefined;
}

/** One agent file → definition. Throws with a readable message for broken files. */
export function parseAgentFile(file: string, text: string): AgentDef {
  const { data, body } = parseFrontmatter(text);
  const name = data.name || path.basename(file, path.extname(file));
  if (!NAME_RE.test(name)) throw new Error(`${file}: agent name "${name}" may only use letters, digits, - and _`);
  if (!data.description) throw new Error(`${file}: missing "description" in the frontmatter`);
  if (!body) throw new Error(`${file}: the prompt (text after the frontmatter) is empty`);
  return {
    name,
    description: data.description,
    prompt: `${body}\n\n${REPORT_RULES}`,
    tools: parseList(data.tools),
    model: data.model || undefined,
    source: file,
  };
}

export interface LoadedAgents {
  agents: AgentDef[];
  /** Files that couldn't be used, with the reason. Shown by /agents rather than crashing. */
  errors: string[];
}

export function loadAgents(cwd: string): LoadedAgents {
  const byName = new Map(BUILTIN_AGENTS.map((a) => [a.name.toLowerCase(), a]));
  const errors: string[] = [];
  for (const dir of agentDirs(cwd)) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
    } catch {
      continue; // folder doesn't exist: nothing to load
    }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const a = parseAgentFile(file, fs.readFileSync(file, 'utf8'));
        byName.set(a.name.toLowerCase(), a);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  }
  return { agents: [...byName.values()], errors };
}

export function findAgent(agents: AgentDef[], name: string): AgentDef | undefined {
  return agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
}

/** Tools a sub-agent never gets: no recursion (Task) and no checklist that nobody would see. */
export const PARENT_ONLY_TOOLS = ['Task', 'TodoWrite'];

/** The agent's tool names, resolved against what's enabled. */
export function agentToolNames(agent: AgentDef, enabled: string[]): string[] {
  const allowed = enabled.filter((n) => !PARENT_ONLY_TOOLS.includes(n));
  if (!agent.tools) return allowed;
  const want = new Set(agent.tools.map((t) => t.toLowerCase()));
  return allowed.filter((n) => want.has(n.toLowerCase()));
}
