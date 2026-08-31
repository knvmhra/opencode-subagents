import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { profile } from "./config.js"
import type { InterruptInput, ReviewInput, SetupInput, StartInput, StatusInput } from "./contracts.js"
import type {
  AgentClient,
  Config,
  Connection,
  Connector,
  Context,
  Failure,
  FailureKind,
  Location,
  Model,
  RemoteAuth,
  Run,
  RunState,
  Snapshot,
} from "./types.js"
import { BridgeError } from "./types.js"

export class Coordinator {
  private readonly contexts = new Map<string, Context>()
  private readonly runs = new Map<string, Run>()
  private readonly cycles = new Map<string, number>()
  private readonly stopping = new AbortController()

  constructor(
    private readonly config: Config,
    private readonly connector: Connector,
  ) {}

  async setup(input: SetupInput): Promise<Record<string, unknown>> {
    if (input.action === "begin") {
      const context: Context = {
        id: id("ctx"),
        ...(input.name === undefined ? {} : { name: input.name }),
        state: "pending",
        target: input.target,
        intent: input.intent,
        createdAt: Date.now(),
      }
      this.contexts.set(context.id, context)
      return {
        context_id: context.id,
        state: context.state,
        target: context.target,
        next: "Use any parent-owned tools needed to prepare the target, then call setup with action=commit.",
      }
    }

    if (input.action === "local") {
      const directory = await local(input.directory ?? process.cwd())
      const connection: Connection = { target: "local" }
      const client = await this.connector.connect(connection)
      const context: Context = {
        id: id("ctx"),
        ...(input.name === undefined ? {} : { name: input.name }),
        state: "ready",
        target: "local",
        directory,
        ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
        connection,
        client,
        createdAt: Date.now(),
      }
      this.contexts.set(context.id, context)
      return this.context(context)
    }

    const context = this.needContext(input.context_id)
    if (context.state !== "pending") throw new BridgeError("context_ready", `Context ${context.id} is already ready`)
    const directory = context.target === "remote_server" ? input.directory : await local(input.directory)
    const auth = input.auth === undefined ? undefined : remoteAuth(input.auth)
    const connection: Connection =
      context.target === "remote_server"
        ? {
            target: "remote_server",
            url: required(input.server_url, "server_url is required for a remote_server context"),
            ...(auth === undefined ? {} : { auth }),
          }
        : { target: "shell_handoff" }
    const client = await this.connector.connect(connection)
    Object.assign(context, {
      state: "ready" as const,
      directory,
      ...(input.workspace_id === undefined ? {} : { workspaceID: input.workspace_id }),
      ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
      connection,
      client,
    })
    return this.context(context)
  }

  async start(input: StartInput): Promise<Record<string, unknown>> {
    if (input.continue_from !== undefined) return this.resume(input)
    const context = this.ready(required(input.context_id, "context_id is required for a new run"))
    const task = required(input.task, "task is required for a new run")
    const selected = profile(this.config, "worker", input.alias, input.model, input.agent)
    const run: Run = {
      id: id("run"),
      kind: "work",
      contextID: context.id,
      sessionID: "",
      task,
      access: input.access,
      alias: selected.alias,
      ...(selected.agent === undefined ? {} : { agent: selected.agent }),
      ...(selected.model === undefined ? {} : { model: selected.model }),
      state: "starting",
      startedAt: Date.now(),
      blockers: [],
    }
    this.acquire(context, run)
    try {
      run.baseline = await context.client.snapshot(location(context))
      run.sessionID = await context.client.create({
        location: location(context),
        title: `delegated: ${task.slice(0, 80)}`,
        ...(run.agent === undefined ? {} : { agent: run.agent }),
        ...(run.model === undefined ? {} : { model: run.model }),
        metadata: { bridge: "opencode-subagents", run_id: run.id, kind: run.kind },
      })
      this.runs.set(run.id, run)
      await context.client.prompt(run.sessionID, workPrompt(task, context.handoff, selected.profile.instructions))
      run.state = "running"
      this.launch(run)
      return this.run(run, "compact")
    } catch (error) {
      this.release(context, run)
      throw error
    }
  }

  async interrupt(input: InterruptInput): Promise<Record<string, unknown>> {
    const run = this.needRun(input.run_id)
    if (!active(run.state)) return { run_id: run.id, state: run.state, terminal: true, interrupted: false }
    run.state = "interrupting"
    const context = this.ready(run.contextID)
    const interrupted = await context.client.interrupt(run.sessionID)
    if (!interrupted) {
      run.state = "interrupted"
      run.finishedAt = Date.now()
      this.release(context, run)
    }
    return {
      run_id: run.id,
      state: run.state,
      terminal: !active(run.state),
      interrupted,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }
  }

  async review(input: ReviewInput): Promise<Record<string, unknown>> {
    const source = this.needRun(input.run_id)
    if (source.kind !== "work") throw new BridgeError("invalid_review", "A review must target a work run")
    if (!input.allow_partial && source.state !== "succeeded") {
      throw new BridgeError("run_incomplete", `Run ${source.id} is ${source.state}; set allow_partial to review it anyway`)
    }
    const context = this.ready(source.contextID)
    if (context.writer !== undefined) throw new BridgeError("writer_active", `Context ${context.id} still has an active writer`)
    const current = await context.client.snapshot(location(context))
    if (source.snapshot !== undefined && current?.hash !== source.snapshot.hash) {
      throw new BridgeError("stale_candidate", "The working state changed after the source run completed")
    }
    const selected = profile(this.config, "reviewer", input.alias, input.model, input.agent)
    const run: Run = {
      id: id("review"),
      kind: "review",
      contextID: context.id,
      sourceRunID: source.id,
      sessionID: "",
      task: `Review ${source.id}`,
      access: "read",
      alias: selected.alias,
      ...(selected.agent === undefined ? {} : { agent: selected.agent }),
      ...(selected.model === undefined ? {} : { model: selected.model }),
      state: "starting",
      startedAt: Date.now(),
      ...(current === undefined ? {} : { baseline: current }),
      blockers: [],
    }
    run.sessionID = await context.client.create({
      location: location(context),
      title: `review: ${source.task.slice(0, 80)}`,
      ...(run.agent === undefined ? {} : { agent: run.agent }),
      ...(run.model === undefined ? {} : { model: run.model }),
      metadata: { bridge: "opencode-subagents", run_id: run.id, source_run_id: source.id, kind: run.kind },
    })
    this.runs.set(run.id, run)
    await context.client.prompt(
      run.sessionID,
      reviewPrompt(source, context.handoff, input.instructions, selected.profile.instructions),
    )
    run.state = "running"
    this.launch(run)
    return this.run(run, "compact")
  }

  async status(input: StatusInput): Promise<Record<string, unknown>> {
    if (input.run_id === undefined) {
      return {
        contexts: [...this.contexts.values()].map((context) => this.context(context)),
        runs: [...this.runs.values()].map((run) => this.run(run, "compact")),
      }
    }
    const run = this.needRun(input.run_id)
    const output = this.run(run, input.detail)
    if (run.snapshot === undefined || active(run.state)) return output
    const context = this.ready(run.contextID)
    const current = await context.client.snapshot(location(context))
    return { ...output, stale: current?.hash !== run.snapshot.hash }
  }

  async close(): Promise<void> {
    this.stopping.abort()
    const failures: string[] = []
    await Promise.allSettled(
      [...this.runs.values()].map(async (run) => {
        const context = this.contexts.get(run.contextID)
        if (context?.client === undefined || run.sessionID.length === 0) return
        try {
          if (active(run.state)) await context.client.interrupt(run.sessionID)
          await context.client.remove(run.sessionID)
        } catch (error) {
          failures.push(`${run.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }),
    )
    this.runs.clear()
    this.cycles.clear()
    if (failures.length > 0) {
      throw new BridgeError("close_failed", `Failed to clean up delegated sessions: ${failures.join("; ")}`)
    }
  }

  private async resume(input: StartInput): Promise<Record<string, unknown>> {
    const run = this.needRun(required(input.continue_from, "continue_from is required"))
    if (active(run.state)) throw new BridgeError("run_active", `Run ${run.id} is already active`)
    if (run.kind !== "work") throw new BridgeError("invalid_resume", "Reviews cannot be resumed with start")
    const context = this.ready(run.contextID)
    this.acquire(context, run)
    const selected =
      input.alias === undefined && input.model === undefined && input.agent === undefined
        ? { alias: run.alias, model: run.model, agent: run.agent, profile: {} as import("./types.js").Profile }
        : profile(this.config, "worker", input.alias, input.model, input.agent)
    try {
      if (selected.agent !== undefined && selected.agent !== run.agent) {
        await context.client.switchAgent(run.sessionID, selected.agent)
      }
      if (selected.model !== undefined && !sameModel(selected.model, run.model)) {
        await context.client.switchModel(run.sessionID, selected.model)
      }
      run.alias = selected.alias
      if (selected.agent === undefined) delete run.agent
      else run.agent = selected.agent
      if (selected.model === undefined) delete run.model
      else run.model = selected.model
      run.state = "running"
      run.startedAt = Date.now()
      delete run.finishedAt
      delete run.result
      delete run.failure
      delete run.verdict
      run.blockers = []
      await context.client.prompt(
        run.sessionID,
        continuationPrompt(input.task, context.handoff, selected.profile.instructions),
      )
      this.launch(run)
      return this.run(run, "compact")
    } catch (error) {
      this.release(context, run)
      throw error
    }
  }

  private launch(run: Run): void {
    if (this.stopping.signal.aborted) return
    const cycle = (this.cycles.get(run.id) ?? 0) + 1
    this.cycles.set(run.id, cycle)
    void this.settle(run, cycle)
  }

  private async settle(run: Run, cycle: number): Promise<void> {
    const context = this.ready(run.contextID)
    const stop = new AbortController()
    const guard = this.guard(run, cycle, AbortSignal.any([stop.signal, this.stopping.signal]))
    let caught: unknown
    try {
      await context.client.wait(run.sessionID)
    } catch (error) {
      caught = error
    } finally {
      stop.abort()
      await guard
    }
    if (this.stopping.signal.aborted) return
    if (this.cycles.get(run.id) !== cycle) return

    const [info, messages, snapshot] = await Promise.all([
      context.client.info(run.sessionID).catch(() => undefined),
      context.client.messages(run.sessionID).catch(() => []),
      context.client.snapshot(location(context)),
    ])
    const last = messages.at(-1)
    const error = last?.error ?? errorValue(caught)
    if (last?.text !== undefined) run.result = last.text
    if (info !== undefined) {
      run.usage = {
        cost: info.cost,
        tokens: {
          input: info.tokens.input,
          output: info.tokens.output,
          reasoning: info.tokens.reasoning,
          cacheRead: info.tokens.cache.read,
          cacheWrite: info.tokens.cache.write,
        },
      }
    }
    if (snapshot !== undefined) run.snapshot = snapshot
    run.finishedAt = Date.now()

    if (run.state === "interrupting" || info?.outcome === "interrupted") {
      run.state = "interrupted"
      run.failure = { kind: "interrupted", message: error?.message ?? "Run interrupted" }
    } else if (error !== undefined) {
      run.failure = classifyFailure(error.message, error.type)
      run.state = blocking(run.failure.kind) ? "blocked" : "failed"
    } else if (blocked(run.result)) {
      run.state = "blocked"
      run.failure = { kind: "permission_denied", message: run.result ?? "Worker reported a blocker" }
    } else if (info?.outcome === "failed") {
      run.state = "failed"
      run.failure = { kind: "unknown_provider_error", message: "OpenCode reported a failed session" }
    } else {
      run.state = "succeeded"
    }
    if (run.kind === "review") run.verdict = verdict(run.result, run.state)
    this.release(context, run)
  }

  private async guard(run: Run, cycle: number, signal: AbortSignal): Promise<void> {
    const context = this.ready(run.contextID)
    while (!signal.aborted && this.cycles.get(run.id) === cycle) {
      const [permissions, forms] = await Promise.all([
        context.client.permissions(run.sessionID).catch(() => []),
        context.client.forms(run.sessionID).catch(() => []),
      ])
      await Promise.allSettled(
        permissions.map(async (request) => {
          const note = `Denied non-interactive permission: ${request.action} ${request.resources.join(", ")}`
          if (!run.blockers.includes(note)) run.blockers.push(note)
          await context.client.rejectPermission(run.sessionID, request.id)
        }),
      )
      await Promise.allSettled(
        forms.map(async (form) => {
          const note = `Cancelled non-interactive question: ${form.title}`
          if (!run.blockers.includes(note)) run.blockers.push(note)
          await context.client.cancelForm(run.sessionID, form.id)
        }),
      )
      await delay(350, signal)
    }
  }

  private acquire(context: Context, run: Run): void {
    if (run.access === "read") return
    if (context.writer !== undefined && context.writer !== run.id) {
      throw new BridgeError("writer_active", `Context ${context.id} is already owned by writer ${context.writer}`)
    }
    context.writer = run.id
  }

  private release(context: Context, run: Run): void {
    if (context.writer === run.id) delete context.writer
  }

  private ready(contextID: string): Context & { client: AgentClient; directory: string } {
    const context = this.needContext(contextID)
    if (context.state !== "ready" || context.client === undefined || context.directory === undefined) {
      throw new BridgeError("context_pending", `Context ${context.id} has not been committed`)
    }
    return context as Context & { client: AgentClient; directory: string }
  }

  private needContext(contextID: string): Context {
    const context = this.contexts.get(contextID)
    if (context === undefined) throw new BridgeError("context_not_found", `Unknown context: ${contextID}`)
    return context
  }

  private needRun(runID: string): Run {
    const run = this.runs.get(runID)
    if (run === undefined) throw new BridgeError("run_not_found", `Unknown run: ${runID}`)
    return run
  }

  private context(context: Context): Record<string, unknown> {
    return {
      context_id: context.id,
      ...(context.name === undefined ? {} : { name: context.name }),
      state: context.state,
      target: context.target,
      ...(context.directory === undefined ? {} : { directory: context.directory }),
      ...(context.writer === undefined ? {} : { writer: context.writer }),
    }
  }

  private run(run: Run, detail: StatusInput["detail"]): Record<string, unknown> {
    const compact: Record<string, unknown> = {
      run_id: run.id,
      kind: run.kind,
      state: run.state,
      terminal: !active(run.state),
      context_id: run.contextID,
      ...(run.sourceRunID === undefined ? {} : { source_run_id: run.sourceRunID }),
      alias: run.alias,
      ...(run.agent === undefined ? {} : { agent: run.agent }),
      ...(run.model === undefined ? {} : { model: modelName(run.model) }),
      elapsed_ms: (run.finishedAt ?? Date.now()) - run.startedAt,
      ...(run.usage === undefined ? {} : { usage: run.usage }),
      ...(run.failure === undefined ? {} : { failure: run.failure }),
      ...(run.verdict === undefined ? {} : { verdict: run.verdict }),
    }
    if (detail === "compact") return compact
    const result = {
      ...compact,
      ...(run.result === undefined ? {} : { result: run.result }),
      ...(run.snapshot === undefined ? {} : { changed_files: run.snapshot.files, snapshot: run.snapshot.hash }),
      ...(run.blockers.length === 0 ? {} : { blockers: run.blockers }),
    }
    if (detail === "result") return result
    return {
      ...result,
      session_id: run.sessionID,
      started_at: new Date(run.startedAt).toISOString(),
      ...(run.finishedAt === undefined ? {} : { finished_at: new Date(run.finishedAt).toISOString() }),
      ...(run.baseline === undefined ? {} : { baseline: run.baseline.hash }),
    }
  }
}

export function classifyFailure(message: string, type?: string): Failure {
  const text = `${type ?? ""} ${message}`.toLowerCase()
  const match: Array<[RegExp, FailureKind]> = [
    [/\b402\b|insufficient.*credit|credit.*(exhaust|deplet|balance)|payment required/, "funds_exhausted"],
    [/budget.*(exceed|limit)|spend.*limit|\b403\b.*budget/, "budget_exceeded"],
    [/rate.?limit|too many requests|\b429\b/, "rate_limited"],
    [/unauthori[sz]ed|invalid.*(key|token)|authentication|\b401\b/, "authentication_failed"],
    [/context.*(length|window)|max.*tokens|prompt.*too long/, "context_exhausted"],
    [/permission|denied|forbidden/, "permission_denied"],
    [/unavailable|overloaded|upstream|provider.*error|\b5\d\d\b/, "provider_unavailable"],
  ]
  return {
    kind: match.find(([pattern]) => pattern.test(text))?.[1] ?? "unknown_provider_error",
    message,
    ...(type === undefined ? {} : { type }),
  }
}

function workPrompt(task: string, handoff?: string, instructions?: string): string {
  return [
    "Complete the bounded task below autonomously. Do not ask the user questions. If required access or information is unavailable, stop and report BLOCKED with the exact missing prerequisite.",
    handoff === undefined ? undefined : `Environment handoff:\n${handoff}`,
    instructions,
    `Task:\n${task}`,
    "Keep the final response under 500 words and use exactly these headings: Outcome, Changed, Tests, Blockers.",
  ]
    .filter((part) => part !== undefined && part.length > 0)
    .join("\n\n")
}

function continuationPrompt(task?: string, handoff?: string, instructions?: string): string {
  return [
    "Continue the interrupted or blocked task from the existing filesystem and session state. Do not repeat completed work.",
    task,
    handoff === undefined ? undefined : `Environment handoff:\n${handoff}`,
    instructions,
    "Keep the final response under 500 words and use exactly these headings: Outcome, Changed, Tests, Blockers.",
  ]
    .filter((part) => part !== undefined && part.length > 0)
    .join("\n\n")
}

function reviewPrompt(source: Run, handoff?: string, instructions?: string, profileInstructions?: string): string {
  return [
    "Perform an independent code review of the current working state. You are a fresh reviewer: do not trust the implementation summary and do not edit files. Focus on correctness, regressions, security, and missing tests. Use tools to inspect the actual changes.",
    handoff === undefined ? undefined : `Environment handoff:\n${handoff}`,
    `Original task:\n${source.task}`,
    source.result === undefined ? undefined : `Implementer handoff:\n${source.result}`,
    source.snapshot === undefined ? undefined : `Expected changed files:\n${source.snapshot.files.join("\n")}`,
    instructions,
    profileInstructions,
    "Return exactly these headings: Verdict (PASS, FAIL, or BLOCKED), Findings (severity ordered, with file:line), Tests, Notes. Be concise.",
  ]
    .filter((part) => part !== undefined && part.length > 0)
    .join("\n\n")
}

function remoteAuth(auth: NonNullable<Extract<SetupInput, { action: "commit" }>['auth']>): RemoteAuth {
  if (auth.kind === "bearer") return { kind: auth.kind, tokenEnv: auth.token_env }
  if (auth.kind === "basic") return { kind: auth.kind, username: auth.username, passwordEnv: auth.password_env }
  return { kind: auth.kind, name: auth.name, valueEnv: auth.value_env }
}

function location(context: Context & { directory: string }): Location {
  return {
    directory: context.directory,
    ...(context.workspaceID === undefined ? {} : { workspaceID: context.workspaceID }),
  }
}

function verdict(result: string | undefined, state: RunState): "pass" | "fail" | "blocked" {
  if (state === "blocked") return "blocked"
  // Reviewers routinely decorate the requested headings with markdown ("## Verdict", "**PASS**").
  // Tolerate that decoration; an unparseable verdict still fails closed.
  const line = result?.match(/Verdict[*_\`]*\s*[:\n][\s#*_>\`-]*(PASS|FAIL|BLOCKED)\b/i)?.[1]?.toUpperCase()
  if (line === "PASS") return "pass"
  if (line === "BLOCKED") return "blocked"
  return "fail"
}

function blocked(result?: string): boolean {
  return result !== undefined && /(?:^|\n)[\s#*_>\`-]*(?:Outcome[*_\`]*\s*[:\n][\s#*_>\`-]*)?BLOCKED\b/i.test(result)
}

function blocking(kind: FailureKind): boolean {
  return ["funds_exhausted", "budget_exceeded", "authentication_failed", "permission_denied"].includes(kind)
}

function errorValue(error: unknown): { type?: string; message: string } | undefined {
  if (error === undefined) return undefined
  if (error instanceof Error) return { type: error.name, message: error.message }
  return { message: String(error) }
}

function sameModel(a: Model, b?: Model): boolean {
  return b !== undefined && a.providerID === b.providerID && a.id === b.id && a.variant === b.variant
}

function modelName(model: Model): string {
  return `${model.providerID}/${model.id}${model.variant === undefined ? "" : `#${model.variant}`}`
}

function active(state: RunState): boolean {
  return state === "starting" || state === "running" || state === "interrupting"
}

async function local(directory: string): Promise<string> {
  const path = resolve(directory)
  const info = await stat(path).catch(() => undefined)
  if (!info?.isDirectory()) throw new BridgeError("invalid_directory", `Directory does not exist: ${path}`)
  return path
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new BridgeError("invalid_input", message)
  return value
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
