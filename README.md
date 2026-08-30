# OpenCode Subagents

`opencode-subagents` is a small MCP control plane that lets a root coding agent delegate bounded work to any model OpenCode can reach. It exposes exactly five tools:

| Tool | Purpose |
| --- | --- |
| `setup` | Create a local context, or pause a two-phase setup while the root agent prepares an environment with its own tools |
| `start` | Launch asynchronous work, or resume an existing work session with an optional model override |
| `interrupt` | Stop a run without discarding its filesystem or OpenCode session state |
| `status` | Read compact progress, the final handoff, or diagnostics |
| `review` | Launch a fresh, non-editing model to review the candidate before CI |

The server deliberately does not proxy chat. Workers return a short structured handoff, and `status` never dumps their transcript into the root model's context.

## Design boundaries

- State is scoped to the lifetime of the MCP process. Shutdown interrupts active work and removes its OpenCode sessions.
- A context has at most one declared writer. No worktrees are created; runs share the checkout selected by `setup`.
- `access=read` and the reviewer's `plan` agent are coordination contracts, not a security sandbox. Do not point an untrusted model at valuable credentials or a sensitive host.
- There is no local token or spend policy. OpenRouter/provider limits remain the authority. Credit, budget, authentication, rate-limit, provider, context-window, and permission failures are returned as typed run failures.
- Provider failures never trigger a silent model fallback. Resume deliberately with `start.continue_from` and, if useful, a new `model` or `alias`.

## Install

Node.js 22 or newer is required. The exact OpenCode 2 beta compatible with the client is pinned and installed with this package; a global `opencode2` is not required.

```sh
npm ci
npm run build
npm link
```

Configure a provider using the bundled CLI, then confirm the model identifiers you want to alias:

```sh
./node_modules/.bin/opencode2 auth login
./node_modules/.bin/opencode2 models
```

OpenCode's normal environment credentials also work. For OpenRouter, that commonly means making the relevant API key available to the MCP server process.

## Configure models

Copy [`config.example.json`](./config.example.json) to `~/.config/opencode-subagents/config.json` and replace the placeholder model names. A model uses `provider/model` syntax; nested OpenRouter IDs work, for example `openrouter/vendor/model`. Append `#variant` when OpenCode exposes a variant.

The built-in aliases are intentionally provider-neutral:

```json
{
  "aliases": {
    "worker": { "agent": "build" },
    "reviewer": { "agent": "plan" }
  },
  "defaults": { "worker": "worker", "reviewer": "reviewer" }
}
```

Without configured model names, OpenCode chooses its own current/default model. Every `start` and `review` call can override `alias`, `model`, or `agent`.

Set `OPENCODE_SUBAGENTS_CONFIG=/absolute/path/config.json` to use a different file. `service.command` may point at a custom OpenCode 2 build; the special leading command `opencode2` resolves to this package's pinned binary.

## Connect a root agent

After `npm link`, add the stdio server to Codex:

```sh
codex mcp add opencode-subagents -- opencode-subagents
```

Or add it to Claude Code at user scope:

```sh
claude mcp add --scope user --transport stdio opencode-subagents -- opencode-subagents
```

Instead of `npm link`, either client can invoke `node /absolute/path/to/opencode-subagents/dist/src/cli.js` as its MCP command.

The optional [`opencode-delegation`](./skills/opencode-delegation/SKILL.md) skill teaches the root agent the low-context workflow. Install it for one or both clients:

```sh
cp -R skills/opencode-delegation ~/.codex/skills/
cp -R skills/opencode-delegation ~/.claude/skills/
```

Claude Code may need a restart only if `~/.claude/skills` did not exist when the current session began.

## Workflow

For a normal checkout, setup is one call:

```json
{ "action": "local", "directory": "/absolute/project/path" }
```

Pass the returned `context_id` to `start`, poll `status` by `run_id`, and request `detail=result` only when the run is terminal. A successful work run can then be passed to `review`. Review refuses a candidate whose VCS snapshot changed after the source run, avoiding accidental review of a different filesystem state.

Environment preparation is two-phase by design:

1. Call `setup` with `action=begin`, an English `intent`, and `target=shell_handoff` or `target=remote_server`.
2. The root agent uses any of its own tools—SSH, credential brokers, cloud APIs, serial consoles, and so on—to prepare the environment.
3. Call `setup` with `action=commit` and the same `context_id`.

For `shell_handoff`, `directory` is a local working directory and `handoff` tells the worker how to enter the prepared environment, such as the SSH host alias and remote path. The OpenCode worker runs locally and performs that handoff itself.

For `remote_server`, the root agent starts or discovers an OpenCode 2 service on the target, then commits its `server_url`, remote `directory`, and optional `workspace_id`. Authentication values are never passed as tool arguments; `auth` names an environment variable containing the secret. Expose remote services only through an authenticated private network or tunnel.

## Development

```sh
npm run check
npm test
npm run smoke
```

`smoke` verifies the stdio MCP handshake and exact five-tool surface, then starts the bundled OpenCode service with isolated XDG directories under the system temp directory, checks its health, and stops it. It does not invoke a model. Use `npm run smoke:mcp` when localhost binding is unavailable.

The implementation currently targets the pinned OpenCode 2 beta API. Keep `@opencode-ai/client` and `@opencode-ai/cli` on the same exact version when upgrading.
