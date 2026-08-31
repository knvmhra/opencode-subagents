import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Directory where each MCP server process mirrors its state for the dashboard. */
export function dashDir(): string {
  const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
  return join(state, "opencode-subagents", "dash")
}

let warned = false

/** Best-effort snapshot for opencode-subagents-dash; a failed write never disturbs the run itself. */
export function writeDash(payload: Record<string, unknown>): void {
  try {
    const dir = dashDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${process.pid}.json`)
    const temp = `${file}.tmp`
    writeFileSync(temp, JSON.stringify(payload))
    renameSync(temp, file)
  } catch (error) {
    if (!warned) {
      warned = true
      console.error(
        `[opencode-subagents] dash: cannot write state file (further warnings suppressed): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

export function clearDash(): void {
  // Best-effort: the dash also reaps files whose process has exited.
  rmSync(join(dashDir(), `${process.pid}.json`), { force: true })
}
