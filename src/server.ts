import { McpServer, type CallToolResult } from "@modelcontextprotocol/server"
import type { Coordinator } from "./coordinator.js"
import { InterruptSchema, ReviewSchema, SetupSchema, StartSchema, StatusSchema } from "./contracts.js"
import { BridgeError } from "./types.js"

export function buildServer(coordinator: Coordinator): McpServer {
  const server = new McpServer({ name: "opencode-subagents", version: "0.1.0" })

  server.registerTool(
    "setup",
    {
      title: "Set up delegation context",
      description:
        "Create an OpenCode execution context. Use action=local for a one-call local setup. For SSH or other parent-prepared environments, call action=begin, perform arbitrary setup with parent-owned tools, then call action=commit.",
      inputSchema: SetupSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) => safe(() => coordinator.setup(input)),
  )

  server.registerTool(
    "start",
    {
      title: "Start delegated work",
      description:
        "Start one asynchronous OpenCode worker with minimal context. Returns immediately with a run_id. A context permits only one write run at a time. Use continue_from to resume a failed, blocked, or interrupted work run, optionally with a model override.",
      inputSchema: StartSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (input) => safe(() => coordinator.start(input)),
  )

  server.registerTool(
    "interrupt",
    {
      title: "Interrupt delegated work",
      description:
        "Interrupt an active OpenCode work or review run while preserving its session and filesystem state. The response reports interrupted and terminal; a run is only fully stopped once terminal is true.",
      inputSchema: InterruptSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) => safe(() => coordinator.interrupt(input)),
  )

  server.registerTool(
    "status",
    {
      title: "Check delegated work",
      description:
        "Return compact state for one run or all current-session contexts and runs. Every run payload includes terminal: true once the run has stopped (succeeded, failed, blocked, or interrupted); use detail=result only when terminal is true. Diagnostic includes OpenCode identifiers but never dumps the worker transcript.",
      inputSchema: StatusSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => safe(() => coordinator.status(input)),
  )

  server.registerTool(
    "review",
    {
      title: "Review delegated work",
      description:
        "Launch a fresh, non-editing model to review a completed work run before CI. The reviewer sees the original task and current candidate, not the implementer's transcript. Returns a review run_id immediately.",
      inputSchema: ReviewSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) => safe(() => coordinator.review(input)),
  )

  return server
}

async function safe(operation: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const data = await operation()
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
    }
  } catch (error) {
    const data = {
      error: {
        code: error instanceof BridgeError ? error.code : "internal_error",
        message: error instanceof Error ? error.message : String(error),
      },
    }
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
    }
  }
}
