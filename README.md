# Jarvis

An agentic coding assistant for your terminal that runs on **free and local models**.

Ask it something about your project and it works the way a developer would: searches the code,
reads the relevant files, edits them, runs commands and tests, and reports back. You approve
anything that changes files or runs a command.

It works with OpenRouter's free models, Groq, Google Gemini (free tier), Cerebras, Mistral, and
local models through Ollama or LM Studio. You can switch models at any time, and set backups that
are used automatically when a free tier hits its rate limit.

> Jarvis is a personal learning project in active development.

## Contents

- [Install](#install)
- [Privacy: what stays on your computer](#privacy-what-stays-on-your-computer)
- [Quick start](#quick-start)
- [What it can do](#what-it-can-do)
- [Commands](#commands)
- [Configuration](#configuration)
- [MCP servers](#mcp-servers)
- [Hooks](#hooks)
- [Sub-agents](#sub-agents)
- [Project memory (JARVIS.md)](#project-memory-jarvismd)
- [Security model](#security-model)
- [Development](#development)

## Install

Requires **Node.js 22 or newer** ([download](https://nodejs.org)). Works on Windows, macOS and Linux.

```sh
npm install -g jarvis-code
```

The package is called `jarvis-code`; the command it installs is `jarvis`. Check it worked with
`jarvis --version`.

| To… | Run |
|---|---|
| update to the latest version | `npm update -g jarvis-code` |
| uninstall | `npm uninstall -g jarvis-code` |

The package page is https://www.npmjs.com/package/jarvis-code.

### From source

For trying unreleased changes, or working on Jarvis itself (this also needs Git):

```sh
git clone https://github.com/thamaraiselvank/ai_cli_tool.git
cd ai_cli_tool
npm install
npm run build
npm link          # makes the `jarvis` command use this copy
```

To run straight from source instead, without building: `npm run dev`.

## Privacy: what stays on your computer

Jarvis has no server of its own and collects no data: there's no account, analytics or telemetry.
It only connects to services you set up yourself:

| What leaves your computer | Where it goes | When |
|---|---|---|
| Your messages, and the file contents and command output the model asks for | the AI provider you chose (e.g. Groq, OpenRouter, Gemini) | every request to the model |
| Your API key for that provider | that provider only, to sign in | every request, and when a key is checked |
| Tool calls for an MCP server | the MCP servers you configured | when the model uses their tools |

Everything else stays on your computer: your settings, memory files, saved conversations and
API keys (kept in your OS password store; see [Security model](#security-model)).

The provider *does* see what you send it, so read its privacy policy, especially for free tiers.
Some free plans may use requests to improve their models. For code that must never leave your
machine, use a local model with [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai):
then nothing goes over the network at all.

## Quick start

1. Get a free API key from at least one provider:

   | Provider | Free key | Env variable |
   |---|---|---|
   | OpenRouter | https://openrouter.ai/keys | `OPENROUTER_API_KEY` |
   | Groq | https://console.groq.com/keys | `GROQ_API_KEY` |
   | Gemini | https://aistudio.google.com/apikey | `GEMINI_API_KEY` |
   | Cerebras | https://cloud.cerebras.ai | `CEREBRAS_API_KEY` |
   | Mistral | https://console.mistral.ai/api-keys | `MISTRAL_API_KEY` |
   | Ollama / LM Studio | runs locally, no key | — |

2. Start Jarvis in your project folder:

   ```sh
   cd my-project
   jarvis
   ```

   On first run it walks you through adding a key (`/provider`) and picking a model (`/model`).
   Keys are stored in your OS keychain, not in a plain file.

3. Ask away:

   ```
   > where is the login request validated, and is there a test for it?
   ```

Run a single prompt without the chat UI (handy in scripts):

```sh
jarvis -p "summarize what changed in the last commit"
jarvis -p "fix the failing test" --yes     # --yes approves tool calls instead of denying them
```

### Command-line options

| Option | What it does |
|---|---|
| `-m, --model <provider/model>` | use this model, e.g. `groq/openai/gpt-oss-120b` |
| `-f, --fallback <refs>` | comma-separated backup models |
| `-p, --print <prompt>` | run one prompt headlessly; answer on stdout, tool activity on stderr |
| `-y, --yes` | headless: approve tool calls that would ask (deny rules still apply) |
| `--usage` | headless: print token usage at the end |
| `-c, --continue` | continue the latest conversation in this folder |
| `-r, --resume [id]` | resume a saved conversation (no id: pick from a list) |

Other subcommands: `jarvis ui` (settings page), `jarvis models <provider> [--free]`, `jarvis tools`,
`jarvis mcp`, `jarvis trust`.

## What it can do

**Tools the model can use**

| Tool | Purpose | Asks first? |
|---|---|---|
| Read | read a file, or a range of lines | no (inside the project) |
| Glob | find files by name pattern | no |
| Grep | search file contents with a regex | no |
| Edit | exact string replacement in a file, shown as a diff | yes |
| Write | create or overwrite a file | yes |
| Bash | run a command (PowerShell on Windows, `sh` elsewhere) | yes |
| TodoWrite | keep a visible checklist for multi-step work | no |
| Task | delegate a job to a [sub-agent](#sub-agents) | read-only agents: no |
| `mcp__*` | tools from your [MCP servers](#mcp-servers) | yes |

**Built for free tiers**

- **Rate limits:** requests are paced per provider, and Jarvis waits when a provider asks it to
  (`Retry-After`). If a model stays unavailable, it moves to the next model in your fallback list.
- **Context management:** tool output is capped. When the conversation fills up, old tool results
  are cleared first; if that isn't enough, older messages are summarized.
- **Prompt caching:** the system prompt stays byte-identical between turns, so providers that
  cache prompts can reuse it.
- **Sub-agents** do broad searches in their own context, so the main conversation only grows by
  their short report.

**Sessions:** every conversation is saved as a JSONL file. Use `/resume`, `jarvis -c` or `jarvis -r`
to pick one up again.

## Commands

Type `/` in the chat to see these, with autocomplete.

| Command | What it does |
|---|---|
| `/help` | list commands |
| `/model [provider/model]` | pick the main model |
| `/fallback [clear]` | pick backup models, in order |
| `/provider [name]` | add, test or remove API keys |
| `/config` | open the settings page in your browser |
| `/resume [id]` | continue a saved conversation |
| `/compact [focus]` | summarize older messages to free up context |
| `/context` | how full the context is, and what fills it |
| `/usage` | tokens, cache hits and retries per model |
| `/tools …` | list, enable/disable, or re-describe tools |
| `/agents` | list sub-agents |
| `/mcp [tools\|restart <name>]` | MCP server status, tools, reconnect |
| `/hooks` | list hooks and how to write them |
| `/trust` | trust this folder's own settings (see [Security model](#security-model)) |
| `/memory [add <note>]` | show JARVIS.md files, or add a note |
| `/todos` | show the model's current checklist |
| `/permissions [allow\|deny\|remove <rule>]` | edit permission rules |
| `/clear` | start a new conversation |
| `/exit` | quit |

Press **Esc** to stop a reply and **Ctrl+C** to quit.

## Configuration

Settings are JSON files, merged in this order (later files win):

1. `~/.jarvis/settings.json`: yours, applies to every project
2. `.jarvis/settings.json`: this project, meant to be committed and shared
3. `.jarvis/settings.local.json`: you, this project only (gitignored)

```json
{
  "model": "groq/openai/gpt-oss-120b",
  "fallbacks": ["openrouter/<a-free-model>", "ollama/qwen2.5-coder"],
  "providers": { "groq": { "rpm": 30, "tpm": 6000 } },
  "permissions": {
    "allow": ["Bash(git status)", "Bash(npm test:*)"],
    "deny": ["Read(.env)", "Bash(rm -rf:*)"]
  },
  "context": { "compactAt": 0.75, "maxToolOutputLines": 400 },
  "agents": { "model": "groq/<a-fast-model>" }
}
```

**Settings page.** Prefer a form to editing JSON? Run `jarvis ui`, or type `/config` in the chat.
It opens a page in your browser where you can:

- pick models, with a list fetched from your providers
- add and check API keys
- edit permission rules
- turn tools on or off
- edit MCP servers and hooks
- trust the folder

The page shows which file you're editing and checks your changes before saving. It runs only on
your computer (127.0.0.1), and the link contains a one-time token, so other websites can't change
your settings.

**Permission rules** look like `Tool`, `Tool(exact)` or `Tool(prefix:*)`. A tool name may end in
`*`, so `mcp__github__*` matches every tool from one MCP server. Deny rules always beat allow
rules. Without a matching rule, read-only tools inside the project run freely and everything else
asks you.

**Environment variables:** `JARVIS_MODEL` and `JARVIS_FALLBACKS` override the settings. A `.env`
file in the repo is loaded by `npm run dev`; `.env.example` shows the variables.

## MCP servers

[MCP](https://modelcontextprotocol.io) servers give Jarvis extra tools: GitHub, databases,
browsers and more.

```sh
# a local server (runs as a process)
jarvis mcp add fs -- npx -y @modelcontextprotocol/server-filesystem .

# a remote server; ${GITHUB_TOKEN} is read from your environment, never stored
jarvis mcp add github --url https://example.com/mcp --header "Authorization: Bearer ${GITHUB_TOKEN}"

jarvis mcp list      # connect and show each server's tools
jarvis mcp remove fs
```

Add `--global` to save a server for all projects, or `--local` to keep it private to you in this
project. The result is a `mcpServers` entry in settings:

```json
"mcpServers": {
  "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  "github": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } }
}
```

- The model sees each tool as `mcp__<server>__<tool>`.
- MCP tools always ask before running. Allow a server you trust with
  `/permissions allow mcp__github__*`.
- Servers start in the background when Jarvis opens, and are stopped when you quit.
- A local server receives only basic environment variables (PATH, HOME, …) plus those you list in
  `env`, so your other API keys aren't passed to it.

## Hooks

Hooks are your own shell commands that Jarvis runs at fixed moments. They make a rule like "always
format after editing" happen every time, instead of relying on the model to remember.

```json
"hooks": {
  "PostToolUse": [{ "matcher": "Edit|Write", "command": "npx prettier --write \"$env:JARVIS_FILE\"" }],
  "PreToolUse":  [{ "matcher": "Bash", "command": "node scripts/guard.js" }],
  "Stop":        [{ "command": "npm test --silent", "timeout": 300 }]
}
```

The example uses PowerShell syntax (`$env:JARVIS_FILE`); on macOS and Linux write `"$JARVIS_FILE"`.

| Event | Runs | Exit code 2 means |
|---|---|---|
| `PreToolUse` | before a tool call | block the call (the model is told why) |
| `PostToolUse` | after a tool call | send stderr to the model as feedback |
| `UserPromptSubmit` | before your message is sent | block the message |
| `Stop` | when the model is about to finish | keep working, with stderr as the reason (at most 3 times) |

- **Input:** event details as JSON on stdin, plus the environment variables `JARVIS_EVENT`,
  `JARVIS_TOOL`, `JARVIS_FILE` and `JARVIS_PROJECT_DIR`.
- **Exit 0** means OK. A hook may also print JSON such as `{"decision": "allow"}` (skip the
  permission prompt; deny rules still win), `{"decision": "block", "reason": "…"}`, or
  `{"context": "…"}`. For `UserPromptSubmit`, plain output is added to your message as context.
- **Any other exit code** marks the hook as broken: you see a notice and nothing is blocked.
- `matcher` is a regular expression on the tool name, for tool events only.
- Hooks are re-read on every message and also apply inside sub-agents.

## Sub-agents

The model can hand a job to a sub-agent with the Task tool. A sub-agent works in its own context,
and only its final report comes back to the main conversation.

- **explore** is read-only: it searches the codebase and answers questions. It runs without
  asking, and several can run at once.
- **general** has every tool. Starting it asks once, and its edits and commands still ask as usual.

To add your own, create a markdown file in `.jarvis/agents/` (this project) or `~/.jarvis/agents/`
(everywhere):

```markdown
---
name: reviewer
description: Reviews a change for bugs and missing tests
tools: Read, Grep, Glob, Bash
model: groq/<model>
---
You are a careful code reviewer. Look for bugs, unhandled errors and missing tests…
```

`tools` and `model` are optional. Set a default sub-agent model with `"agents": { "model": "…" }`.

## Project memory (JARVIS.md)

Put conventions in a `JARVIS.md` file and Jarvis follows them in every session, for example:
"use pnpm", "tests live in `tests/`", "never edit `generated/`".

Files are loaded in this order (more specific ones come later and win on conflicts):

1. `~/.jarvis/JARVIS.md`: personal, all projects
2. `JARVIS.md` in each folder from the git root down to where you started Jarvis
3. `JARVIS.local.md`: personal notes for this project (gitignored)

`/memory add Run tests with npm test` appends a line to `./JARVIS.md`. Changes apply from your next
message.

## Security model

- **You approve every change.** Edits, file writes, commands and MCP tools ask first unless an
  allow rule says otherwise. Read-only tools may run freely, but only inside the project folder.
- **Keys** live in your OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret
  Service) or in environment variables. Only when no keychain exists do they go to
  `~/.jarvis/credentials.json`, readable only by you.
- **Folder trust.** A cloned repo can ship its own `.jarvis/` settings, so until you run `/trust`
  (or `jarvis trust`) for a folder, Jarvis ignores everything in that folder's settings that could
  act on its own or leak a key:
  - hooks
  - MCP servers
  - `allow` rules (deny rules still apply)
  - custom provider URLs and key variables

  Jarvis tells you when it is ignoring something. Your global `~/.jarvis/settings.json` always
  applies.

## Development

```sh
npm run dev         # run from source (loads .env)
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run build       # bundle to dist/cli.js
```

The code is TypeScript (strict mode):

- the terminal UI uses [Ink](https://github.com/vadimdemedes/ink)
- model calls go through the [Vercel AI SDK](https://ai-sdk.dev)
- MCP support uses the official MCP TypeScript SDK

How the code is organized:

| Folder | Contents |
|---|---|
| `src/core/` | the agentic loop, context management, sessions, system prompt, memory |
| `src/providers/` | provider adapters, router with fallbacks, rate limiter |
| `src/tools/` | one file per tool |
| `src/agents/` | sub-agent definitions |
| `src/mcp/` | MCP client |
| `src/hooks/` | hook runner |
| `src/permissions/` | permission rules |
| `src/config/` | settings, credentials, folder trust |
| `src/commands/` | slash commands |
| `src/ui/` | Ink components |

`CLAUDE.md` describes the design rules and the roadmap.

**Still to come:** standalone binaries built in CI, and publishing to npm.
