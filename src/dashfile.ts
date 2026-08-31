import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** Who spawned this MCP server (Claude Code, Codex, a script); lets the dash tell sessions apart. */
function detectDispatcher(): { pid: number; command: string } {
  let command = "unknown"
  try {
    command = execFileSync("ps", ["-o", "command=", "-p", String(process.ppid)], { encoding: "utf8" })
      .trim()
      .slice(0, 100)
  } catch {
    // ps unavailable; the ppid alone still disambiguates.
  }
  return { pid: process.ppid, command }
}

const dispatcher = detectDispatcher()

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
    writeFileSync(temp, JSON.stringify({ dispatcher, ...payload }))
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

function markerFile(): string {
  return join(dirname(dashDir()), "service-started-by-bridge")
}

/** Other live bridge sessions, judged by dash state files whose process is still alive. */
export function otherLiveBridgeSessions(): boolean {
  try {
    return readdirSync(dashDir()).some((name) => {
      if (!name.endsWith(".json")) return false
      const pid = Number(name.slice(0, -".json".length))
      if (!Number.isInteger(pid) || pid === process.pid) return false
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
      }
    })
  } catch {
    return false
  }
}

/** Record that a bridge process started the shared OpenCode service, so the last bridge session out may stop it. */
export function markServiceStartedByBridge(): void {
  try {
    mkdirSync(dirname(markerFile()), { recursive: true })
    writeFileSync(markerFile(), String(process.pid))
  } catch (error) {
    console.error(
      `[opencode-subagents] dash: cannot write service marker: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function serviceStartedByBridge(): boolean {
  return existsSync(markerFile())
}

export function clearServiceMarker(): void {
  rmSync(markerFile(), { force: true })
}
