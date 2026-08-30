---
name: opencode-delegation
description: Delegate bounded implementation, investigation, or pre-CI review to cost-efficient models through the opencode-subagents MCP server. Use when work can be handed to an autonomous OpenCode worker, when the user asks for a fresh independent code review, or when a prepared local/SSH/remote environment should be handed off without filling the root model's context with a subagent transcript.
---

# OpenCode Delegation

Use the server's five tools as a control plane, not as a chat channel. Keep the root context small and retain responsibility for decomposition, environment preparation, and final verification.

## Establish the context

For a local checkout, call `setup` once with `action=local` and an absolute `directory`. Reuse the returned `context_id` for related runs.

When preparation needs parent-owned tools, call `setup` with `action=begin`, a concrete English `intent`, and one of these targets:

- `shell_handoff`: prepare SSH, a VM, credentials, mounts, or other state with the root agent's tools. Then commit a local `directory` and a concise `handoff` telling the worker how to enter and operate in that environment.
- `remote_server`: prepare a reachable OpenCode 2 service on the target. Then commit its `server_url`, remote `directory`, optional `workspace_id`, and authentication environment-variable references.

After `begin`, perform the required setup actions yourself and then call `setup` with `action=commit`. Never place secret values in `handoff` or tool arguments.

## Delegate bounded work

Call `start` with the `context_id` and the smallest task that can be completed and verified autonomously. State the outcome and constraints, not a long reconstruction of the conversation. Let the configured worker alias select the model unless this task warrants an explicit `alias`, `model`, or `agent` override.

Use `access=write` for implementation. Treat the context as exclusively owned until that run becomes terminal: do not edit the same target or start another declared writer meanwhile. `access=read` is only a coordination declaration, not a sandbox.

`start` returns immediately. Continue useful root work, or poll `status` with `detail=compact`. Request `detail=result` only after the run is terminal. Do not request diagnostic detail unless troubleshooting requires the OpenCode session identifier.

If the run is blocked by exhausted funds, provider budget, authentication, or a denied non-interactive request, surface the exact blocker. After it is resolved, call `start` with `continue_from=<run_id>` so the existing session and filesystem state are reused. Override the model deliberately if appropriate; never invent a silent fallback policy.

Use `interrupt` when the work is obsolete, unsafe, or clearly headed in the wrong direction. An interrupted work run can also be continued later with `start.continue_from`.

## Review before CI

After a work run succeeds, call `review` on its `run_id`. This must be a fresh reviewer session; never substitute the implementer's self-review. Use the configured reviewer alias unless a different model is specifically useful.

Poll the returned review run with compact `status`, then fetch the result. A `PASS` is evidence for proceeding to the root agent's own checks or CI, not a replacement for them. On `FAIL`, evaluate the findings and resume the implementer or start a new bounded fix run. On `BLOCKED`, resolve the missing prerequisite before treating the candidate as reviewed.

Review rejects filesystem drift detected after the source run. If the candidate changed, create a work run representing the new candidate and review that result instead.

## Preserve the abstraction

- Do not relay routine subagent messages or transcripts to the user.
- Do report terminal outcome, material changed files, tests, review verdict, cost/token usage when available, and blockers.
- Do not create worktrees unless the user separately requests them. The bridge uses a shared checkout with one declared writer.
- Do not assume `read` mode, review mode, SSH handoff, or a remote service is a security boundary.
