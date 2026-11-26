# CLAUDE.md

Guidance for Claude Code (and any other coding agent) working in this repository.

## What this project is

A personal, open-ended **agentic coding CLI**: a terminal tool in the spirit of Claude Code, built for
learning and daily use. It runs an agentic loop (model → tool calls → tool results → model …) against
**user-configurable models, prioritizing free ones** (OpenRouter free models, Groq, Gemini free tier,
Cerebras, Mistral, local Ollama).

Name: **Jarvis**: npm package `jarvis-code`, command `jarvis`. Settings live in `~/.jarvis/`; env vars use the `JARVIS_` prefix. (Inspired by the Marvel AI; pick an original name before any public launch.)

### Goals

1. **Cross-platform install**: `npm i -g jarvis-code` works on Windows, macOS, Linux. Also ship standalone
   binaries (`bun build --compile`) for each OS via CI.
2. **Agentic loop harness**: system prompt + messages + tool schemas → stream response → run tool calls
   (with permission checks) → feed results back → repeat until the model stops calling tools.
3. **Tools**: Read, Write, Edit (exact string replace), Glob, Grep, Bash, WebFetch, TodoWrite, Task (sub-agent).
4. **Sub-agents**: isolated child loops with their own prompt, tool subset, and (often cheaper) model;
   only the final report returns to the parent.
5. **Multi-provider + rate limiting**: one internal message format, provider adapters, per-provider token
   bucket (RPM/TPM), retry with `Retry-After` + exponential backoff, model fallback chain, usage tracking.
6. **Token efficiency**: tool-output truncation, search-then-read-ranges, Edit over full rewrites,
   auto-compaction at a context threshold, clearing stale tool results, stable prompt prefix for caching,
   sub-agents for context isolation.
7. **Configuration & policy**: layered settings (global → project → local), allow/deny/ask permission
   rules, `/config` inside the TUI, and `jarvis ui` serving a localhost web page to edit settings.
8. **Sessions**: JSONL transcripts, resume previous sessions.
9. **Later**: MCP client, hooks, slash commands, project memory file (`JARVIS.md`).

### Non-goals

- Not a hosted service; everything runs locally.
- Not a clone of Claude Code's UI or branding — same ideas, our own implementation.

## Tech stack (decided)

**Language: TypeScript** (strict mode), Node 22+ as the supported runtime (current `ai`, `ink`,
`commander`, `vitest` all require it), Bun for dev speed and binary builds.

Why TypeScript over Python: frictionless global install via npm on all OSes, Ink gives a first-class
React-style terminal UI, the Vercel AI SDK / zod / MCP SDK are TypeScript-first, and Bun compiles to a
single executable.

| Concern | Library |
|---|---|
| CLI args | `commander` |
| Terminal UI | `ink` + `react` |
| LLM calls | `ai` (Vercel AI SDK) + `@ai-sdk/openai-compatible`, `@ai-sdk/google`, `ollama-ai-provider` |
| Schemas / validation | `zod` |
| File search | `fast-glob`, `@vscode/ripgrep` |
| Token counting | `js-tiktoken` (fallback: chars / 4) |
| Settings web UI | `hono` server on localhost + small React page |
| Secrets | `@napi-rs/keyring` (OS keychain; keytar is unmaintained) or env vars — never plaintext in settings. File fallback `~/.jarvis/credentials.json` (mode 600) only where no keychain exists |
| MCP (later) | `@modelcontextprotocol/sdk` |
| Tests | `vitest` |
| Lint / format | `eslint` + `prettier` |
| Build | `esbuild` bundle (`npm run build`, works on Node 20+); `bun build --compile` for binaries |

## Planned layout

```
src/
  cli.ts                 entry: parse args, launch TUI or headless (-p "prompt")
  ui/                    Ink components: chat, input, permission prompt, status bar, /commands
  core/
    loop.ts              the agentic loop
    messages.ts          internal message types + provider conversion
    context.ts           token counting, truncation, compaction
    session.ts           JSONL transcript persistence / resume
    systemPrompt.ts      builds system prompt (env info, tool guidance, JARVIS.md)
  providers/
    index.ts             provider adapters (OpenAI-compatible, Gemini, Ollama, Anthropic)
    router.ts            model selection + fallback chain
    ratelimit.ts         token bucket, retry/backoff, usage tracking
  tools/                 one file per tool: { name, description, schema, readOnly, run }
  agents/                built-in sub-agent definitions (markdown + frontmatter)
  permissions/           rule matching: allow / deny / ask
  config/                layered settings loader + `jarvis ui` server
  mcp/                   MCP client (later)
tests/
```

## Core design rules

- **One internal message format** (`user` / `assistant` with text + tool_calls / `tool` results keyed by
  `tool_call_id`). Providers convert at the edge; nothing else knows provider formats.
- **Tool errors are returned to the model as tool results**, never thrown out of the loop.
- **Every tool output is capped** (lines and bytes) before entering context.
- **Read-only tools may run in parallel; mutating tools run sequentially.**
- **Permission check before every tool call**: deny rules beat allow rules; default mode is `ask`.
- **System prompt + tool definitions stay byte-stable across turns** (prompt-cache friendly). Put
  volatile info (date, git status) in a clearly delimited block, not scattered.
- Cross-platform: use `path.join`, never hardcode `/`; Bash tool uses PowerShell on Windows, `sh` elsewhere.
- Small free models are unreliable at tool calling: validate tool args with zod and, on failure, send the
  validation error back so the model can retry.

## Settings shape (target)

Files merged in order: `~/.jarvis/settings.json` → `.jarvis/settings.json` → `.jarvis/settings.local.json`.

```json
{
  "model": "openrouter/<free-model>",
  "fallbacks": ["groq/<model>", "ollama/qwen2.5-coder"],
  "providers": { "groq": { "apiKeyEnv": "GROQ_API_KEY", "rpm": 30, "tpm": 6000 } },
  "permissions": {
    "allow": ["Read", "Grep", "Glob", "Bash(git status)"],
    "deny": ["Bash(rm -rf:*)", "Read(.env)"],
    "defaultMode": "ask"
  },
  "context": { "compactAt": 0.75, "maxToolOutputLines": 400 }
}
```

## Roadmap

1. Basic TUI chat with one provider (OpenRouter), streaming text.
2. Tool registry + full agentic loop with Read / Glob / Grep / Bash.
3. Edit / Write, permission prompts, settings files.
4. Multiple providers, router, rate limiting, fallbacks.
5. Token counting, truncation, compaction, session save/resume.
6. Sub-agents (Task), TodoWrite, slash commands, `JARVIS.md` project memory.
7. MCP client, `jarvis ui` settings page, hooks, CI binaries, `npm publish`.

## Commands (once scaffolded)

- `npm install` — install deps
- `npm run dev` — run the CLI from source
- `npm test` — run vitest
- `npm run build` — build for npm
- `npm run build:bin` — compile standalone binaries

## Working conventions for agents in this repo

- This is also a **study project**: when adding a non-obvious mechanism (loop, compaction, rate limiter),
  add a short comment explaining *why*, not just what.
- Keep the core loop free of UI code so it can run headless and be unit-tested.
- Add a vitest test for each tool and for the rate limiter / compaction logic.
- Don't commit API keys; `.jarvis/settings.local.json` and `.env` are gitignored.
