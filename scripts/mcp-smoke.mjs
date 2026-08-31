import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createInterface } from "node:readline"
import { setTimeout as sleep } from "node:timers/promises"

const child = spawn(process.execPath, ["dist/src/cli.js"], { stdio: ["pipe", "pipe", "pipe"] })
const pending = new Map()
let stderr = ""

child.stderr.setEncoding("utf8")
child.stderr.on("data", (chunk) => {
  stderr += chunk
})

const reader = createInterface({ input: child.stdout })
reader.on("line", (line) => {
  const message = JSON.parse(line)
  const waiter = pending.get(message.id)
  if (waiter !== undefined) {
    pending.delete(message.id)
    waiter(message)
  }
})

function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out waiting for ${method}; stderr: ${stderr}`))
    }, 5_000)
    timer.unref()
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolve(message)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  })
}

function exitOrTimeout() {
  return Promise.race([once(child, "exit"), sleep(2_000, "timeout", { ref: false })])
}

try {
  const initialized = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "opencode-subagents-smoke", version: "0.1.0" },
  })
  assert.equal(initialized.error, undefined)
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)

  const listed = await request(2, "tools/list", {})
  assert.equal(listed.error, undefined)
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name).sort(),
    ["interrupt", "review", "setup", "start", "status"],
  )
  console.log("MCP surface healthy: setup, start, interrupt, status, review")

  // The server must shut down cleanly when the client just closes the pipe.
  child.stdin.end()
  assert.notEqual(await exitOrTimeout(), "timeout", `Server did not exit after stdin EOF; stderr: ${stderr}`)
  assert.equal(child.exitCode, 0, `Server exited with code ${child.exitCode}; stderr: ${stderr}`)
  console.log("Clean shutdown on stdin EOF")
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM")
    if ((await exitOrTimeout()) === "timeout") {
      child.kill("SIGKILL")
      await exitOrTimeout()
    }
  }
  reader.close()
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
}
