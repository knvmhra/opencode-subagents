#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { loadConfig } from "./config.js"
import { Coordinator } from "./coordinator.js"
import { OpenCodeConnector } from "./opencode.js"
import { buildServer } from "./server.js"

const config = await loadConfig()
const coordinator = new Coordinator(config, new OpenCodeConnector(config))
const handle = serveStdio(() => buildServer(coordinator), {
  onerror(error) {
    console.error(`[opencode-subagents] ${error.message}`)
  },
})

let closing = false
async function close(): Promise<void> {
  if (closing) return
  closing = true
  await coordinator.close()
  await handle.close()
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)))
process.once("SIGTERM", () => void close().finally(() => process.exit(0)))
process.once("beforeExit", () => void coordinator.close())
