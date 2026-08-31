#!/usr/bin/env node
import { readdirSync, readFileSync, rmSync } from "node:fs"
import { basename, join } from "node:path"
import { dashDir } from "./dashfile.js"

type DashRun = {
  run_id: string
  kind: string
  state: string
  alias: string
  model?: string
  usage?: { cost: number }
  verdict?: string
  failure?: { kind: string }
  task: string
  started_at: number
  finished_at?: number
}

type DashSession = {
  pid: number
  updated_at: number
  contexts: Array<{ context_id: string; directory?: string }>
  runs: DashRun[]
}

const STATE_COLOR: Record<string, string> = {
  starting: "36",
  running: "36",
  interrupting: "33",
  succeeded: "32",
  failed: "31",
  blocked: "33",
  interrupted: "90",
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function sessions(): DashSession[] {
  const dir = dashDir()
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"))
  } catch {
    return []
  }
  const found: DashSession[] = []
  for (const name of names) {
    const file = join(dir, name)
    try {
      const session = JSON.parse(readFileSync(file, "utf8")) as DashSession
      if (!alive(session.pid)) {
        rmSync(file, { force: true })
        continue
      }
      found.push(session)
    } catch {
      // A torn read or foreign file; ignore, it may be complete next tick.
    }
  }
  return found.sort((a, b) => a.pid - b.pid)
}

function paint(text: string, color: string): string {
  return `\x1b[${color}m${text}\x1b[0m`
}

function pad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}

function elapsed(run: DashRun): string {
  const total = Math.max(0, Math.floor(((run.finished_at ?? Date.now()) - run.started_at) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
    : `${minutes}:${String(seconds).padStart(2, "0")}`
}

function render(): void {
  const width = process.stdout.columns ?? 120
  const lines: string[] = []
  const found = sessions()
  lines.push(paint(`opencode-subagents dash — ${new Date().toLocaleTimeString()} — ${found.length} session(s)`, "1"))
  for (const session of found) {
    const directories = session.contexts.map((context) => basename(context.directory ?? context.context_id)).join(", ")
    lines.push("")
    lines.push(paint(`● pid ${session.pid}  ${directories}`, "1;34"))
    const columns = [22, 7, 13, 30, 8, 9, 16]
    const fixed = columns.reduce((sum, column) => sum + column + 2, 0)
    const taskWidth = Math.max(12, width - fixed)
    const header = ["RUN", "KIND", "STATE", "MODEL", "ELAPSED", "COST", "VERDICT/FAILURE", "TASK"]
    lines.push(paint(header.map((cell, i) => pad(cell, [...columns, taskWidth][i]!)).join("  "), "90"))
    for (const run of [...session.runs].sort((a, b) => a.started_at - b.started_at)) {
      const cells = [
        pad(run.run_id, columns[0]!),
        pad(run.kind, columns[1]!),
        paint(pad(run.state, columns[2]!), STATE_COLOR[run.state] ?? "0"),
        pad(run.model ?? run.alias, columns[3]!),
        pad(elapsed(run), columns[4]!),
        pad(run.usage === undefined ? "" : `$${run.usage.cost.toFixed(4)}`, columns[5]!),
        pad(run.verdict ?? run.failure?.kind ?? "", columns[6]!),
        pad(run.task.replace(/\s+/g, " "), taskWidth),
      ]
      lines.push(cells.join("  "))
    }
    if (session.runs.length === 0) lines.push(paint("(no runs yet)", "90"))
  }
  if (found.length === 0) lines.push(paint(`\n(nothing live — watching ${dashDir()})`, "90"))
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}\n`)
}

render()
setInterval(render, 1_000)
