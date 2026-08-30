import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Service } from "@opencode-ai/client/service"
import { OpenCodeConnector } from "../dist/src/opencode.js"

const root = await mkdtemp(join(tmpdir(), "opencode-subagents-smoke-"))
const previous = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
}
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_STATE_HOME = join(root, "state")

try {
  const connector = new OpenCodeConnector({
    aliases: {},
    defaults: { worker: "worker", reviewer: "reviewer" },
    service: { command: ["opencode2", "serve", "--service"] },
  })
  const client = await connector.connect({ target: "local" })
  const health = await client.health()
  console.log(`OpenCode service healthy: ${health.version}`)
} finally {
  await Service.stop().catch(() => undefined)
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
}
