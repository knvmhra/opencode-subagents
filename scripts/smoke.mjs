import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

// The vendor's ensure() timing (promiseTimeout 120s) is not reachable from here because
// service-timing.js is outside @opencode-ai/client's exports map, so a service that never
// becomes healthy is bounded only by that timeout and reported loudly, not worked around.
const connector = new OpenCodeConnector({
  aliases: {},
  defaults: { worker: "worker", reviewer: "reviewer" },
  service: { command: ["opencode2", "serve", "--service"] },
})
let ok = false
try {
  const client = await connector.connect({ target: "local" })
  const health = await client.health()
  assert.equal(connector.startedService, true, "expected this process to have started the isolated service")
  console.log(`OpenCode service healthy: ${health.version}`)
  ok = true
} finally {
  // Stop before restoring XDG_STATE_HOME: Service.stop() resolves the registration file
  // from the environment at call time.
  await connector.stopService().catch((error) => {
    console.error(`[smoke] stopService failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (ok) await rm(root, { recursive: true, force: true })
  else console.error(`[smoke] left ${root} in place; a late-starting service may still register there. Check: pgrep -f 'opencode2.* serve'`)
}
