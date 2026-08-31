#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { loadConfig } from "./config.js"
import { Coordinator } from "./coordinator.js"
import { OpenCodeConnector } from "./opencode.js"
import { buildServer } from "./server.js"

const config = await loadConfig()
const connector = new OpenCodeConnector(config)
const coordinator = new Coordinator(config, connector)
const handle = serveStdio(() => buildServer(coordinator), {
  onerror(error) {
    console.error(`[opencode-subagents] ${error.message}`)
  },
})

let closing = false
async function close(): Promise<void> {
  closing = true
  // Transport first: no new tool call can enter while work is being torn down.
  await step("transport close", 2_000, () => handle.close())
  await step("session cleanup", 2_000, () => coordinator.close())
  // 5s covers waiting out an in-flight ensure() plus the vendor's SIGTERM -> SIGKILL escalation.
  // A timeout here means a service may be left behind: check `pgrep -f 'opencode2.* serve'`.
  await step("service stop", 5_000, () => connector.stopService())
}

async function step(label: string, milliseconds: number, action: () => Promise<void>): Promise<void> {
  const expiry = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), milliseconds).unref()
  })
  try {
    if ((await Promise.race([action().then(() => "done" as const), expiry])) === "timeout") {
      console.error(`[opencode-subagents] shutdown: ${label} did not finish within ${milliseconds}ms`)
    }
  } catch (error) {
    console.error(`[opencode-subagents] shutdown: ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function shutdown(code: number): void {
  // A second signal exits immediately: shutdown must never trap the user.
  if (closing) process.exit(code)
  void close().finally(() => process.exit(code))
}

// serveStdio's transport only listens for stdin "data" and never notices EOF, so a client
// that simply closes the pipe must be observed here.
process.stdin.once("end", () => shutdown(0))
process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))
