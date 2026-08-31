import assert from "node:assert/strict"
import { test } from "node:test"
import { parseModel } from "../src/config.js"
import { Coordinator, classifyFailure } from "../src/coordinator.js"
import { bundledVersion, serviceCommand } from "../src/opencode.js"
import type {
  AgentClient,
  Config,
  Connection,
  Connector,
  Location,
  Model,
  SessionCreate,
  SessionInfo,
  SessionMessage,
  Snapshot,
} from "../src/types.js"

const config: Config = {
  aliases: {
    worker: { model: "openrouter/deepseek/coder", agent: "build" },
    reviewer: { model: "openrouter/z-ai/glm-flash", agent: "plan" },
  },
  defaults: { worker: "worker", reviewer: "reviewer" },
  service: { command: ["opencode2", "serve", "--service"] },
}

test("local setup, exclusive writer, completion, and fresh review", async (t) => {
  const client = new FakeClient()
  const coordinator = new Coordinator(config, new FakeConnector(client))
  t.after(() => coordinator.close())
  const setup = await coordinator.setup({ action: "local", directory: process.cwd() })
  const contextID = string(setup.context_id)

  const started = await coordinator.start({ context_id: contextID, task: "Implement the change", access: "write" })
  const runID = string(started.run_id)
  await assert.rejects(
    coordinator.start({ context_id: contextID, task: "Collide with the writer", access: "write" }),
    /owned by writer/,
  )

  client.snapshotValue = { hash: "candidate", base: "main", files: ["src/change.ts"] }
  client.finish(client.created[0]!, "succeeded", "Outcome\nDone\n\nChanged\nsrc/change.ts\n\nTests\npass\n\nBlockers\nnone")
  await terminal(coordinator, runID, "succeeded")

  const review = await coordinator.review({ run_id: runID, allow_partial: false })
  const reviewID = string(review.run_id)
  assert.notEqual(reviewID, runID)
  assert.equal(client.created.length, 2)
  client.finish(client.created[1]!, "succeeded", "Verdict\nPASS\n\nFindings\nnone\n\nTests\npass\n\nNotes\nclean")
  const reviewed = await terminal(coordinator, reviewID, "succeeded")
  assert.equal(reviewed.verdict, "pass")
})

test("review rejects a candidate that changed after completion", async () => {
  const client = new FakeClient()
  const coordinator = new Coordinator(config, new FakeConnector(client))
  const setup = await coordinator.setup({ action: "local", directory: process.cwd() })
  const run = await coordinator.start({ context_id: string(setup.context_id), task: "Change one file", access: "write" })
  client.snapshotValue = { hash: "candidate", files: ["a.ts"] }
  client.finish(client.created[0]!, "succeeded", "Outcome\nDone")
  await terminal(coordinator, string(run.run_id), "succeeded")
  client.snapshotValue = { hash: "drifted", files: ["a.ts", "b.ts"] }
  await assert.rejects(coordinator.review({ run_id: string(run.run_id), allow_partial: false }), /working state changed/)
  await coordinator.close()
})

test("provider failures are blocked and resumable with a model override", async () => {
  const client = new FakeClient()
  const coordinator = new Coordinator(config, new FakeConnector(client))
  const setup = await coordinator.setup({ action: "local", directory: process.cwd() })
  const started = await coordinator.start({ context_id: string(setup.context_id), task: "Do work", access: "write" })
  const runID = string(started.run_id)
  client.finish(client.created[0]!, "failed", undefined, {
    type: "ProviderError",
    message: "402 Payment Required: insufficient credits",
  })
  const blocked = await terminal(coordinator, runID, "blocked")
  assert.equal((blocked.failure as { kind: string }).kind, "funds_exhausted")

  const resumed = await coordinator.start({
    continue_from: runID,
    task: "Continue without repeating finished work",
    model: "openrouter/z-ai/glm-flash#fast",
    access: "write",
  })
  assert.equal(resumed.run_id, runID)
  assert.equal(client.switchedModels.at(-1)?.variant, "fast")
  client.finish(client.created[0]!, "succeeded", "Outcome\nRecovered")
  await terminal(coordinator, runID, "succeeded")
  await coordinator.close()
})

test("non-interactive permission requests and questions are rejected", async () => {
  const client = new FakeClient()
  client.pendingPermissions = [{ id: "perm_1", action: "external_directory", resources: ["/secret"] }]
  client.pendingForms = [{ id: "form_1", title: "Ask the user" }]
  const coordinator = new Coordinator(config, new FakeConnector(client))
  const setup = await coordinator.setup({ action: "local", directory: process.cwd() })
  await coordinator.start({ context_id: string(setup.context_id), task: "Encounter blockers", access: "read" })
  await until(() => client.rejected.length === 1 && client.cancelled.length === 1)
  assert.deepEqual(client.rejected, ["perm_1"])
  assert.deepEqual(client.cancelled, ["form_1"])
  client.finish(client.created[0]!, "failed", "BLOCKED\nNeed external access")
  await coordinator.close()
})

test("review verdicts survive markdown decoration", async () => {
  const client = new FakeClient()
  const coordinator = new Coordinator(config, new FakeConnector(client))
  const setup = await coordinator.setup({ action: "local", directory: process.cwd() })
  const started = await coordinator.start({ context_id: string(setup.context_id), task: "Implement", access: "write" })
  client.snapshotValue = { hash: "candidate", base: "main", files: ["a.ts"] }
  client.finish(client.created[0]!, "succeeded", "Outcome\nDone")
  await terminal(coordinator, string(started.run_id), "succeeded")

  const review = await coordinator.review({ run_id: string(started.run_id), allow_partial: false })
  client.finish(client.created[1]!, "succeeded", "## Verdict\n\n**PASS**\n\n## Findings\n\n1. **Low** — nit.\n\n## Tests\n\npass")
  const reviewed = await terminal(coordinator, string(review.run_id), "succeeded")
  assert.equal(reviewed.verdict, "pass")
  await coordinator.close()
})

test("interrupt reports terminal and is idempotent", async () => {
  const client = new FakeClient()
  const coordinator = new Coordinator(config, new FakeConnector(client))
  const setup = await coordinator.setup({ action: "local", directory: process.cwd() })
  const started = await coordinator.start({ context_id: string(setup.context_id), task: "Open-ended work", access: "write" })
  const runID = string(started.run_id)
  assert.equal(started.terminal, false)

  const all = await coordinator.status({ detail: "compact" })
  const runs = all.runs as Array<Record<string, unknown>>
  assert.equal(runs.length, 1)
  assert.equal(typeof runs[0]!.terminal, "boolean")

  const interrupting = await coordinator.interrupt({ run_id: runID, reason: "obsolete" })
  assert.equal(interrupting.interrupted, true)
  assert.equal(interrupting.state, "interrupting")
  assert.equal(interrupting.terminal, false)
  assert.equal(interrupting.reason, "obsolete")

  const status = await terminal(coordinator, runID, "interrupted")
  assert.equal((status.failure as { kind: string }).kind, "interrupted")

  const again = await coordinator.interrupt({ run_id: runID })
  assert.deepEqual(again, { run_id: runID, state: "interrupted", terminal: true, interrupted: false })
  await coordinator.close()
})

test("close interrupts live sessions, removes them, and stops polling", async () => {
  const client = new FakeClient()
  const coordinator = new Coordinator(config, new FakeConnector(client))
  const setup = await coordinator.setup({ action: "local", directory: process.cwd() })
  await coordinator.start({ context_id: string(setup.context_id), task: "Never finishes", access: "write" })
  await until(() => client.polls >= 1)

  await coordinator.close()
  assert.deepEqual(client.interrupted, ["session_1"])
  assert.deepEqual(client.removed, ["session_1"])

  const polls = client.polls
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(client.polls, polls)

  await coordinator.close()
})

test("model parsing and provider error classification", () => {
  assert.deepEqual(parseModel("openrouter/deepseek/deepseek-v3#fast"), {
    providerID: "openrouter",
    id: "deepseek/deepseek-v3",
    variant: "fast",
  })
  assert.equal(classifyFailure("Too many requests (429)").kind, "rate_limited")
  assert.equal(classifyFailure("maximum context length reached").kind, "context_exhausted")
  assert.equal(classifyFailure("upstream provider unavailable").kind, "provider_unavailable")
  assert.equal(bundledVersion, "0.0.0-beta-18684")
  assert.match(serviceCommand(["opencode2", "serve", "--service"])[0]!, /@opencode-ai\/cli\/bin\/opencode2\.exe$/)
  assert.deepEqual(serviceCommand(["/opt/custom/opencode2", "serve"]), ["/opt/custom/opencode2", "serve"])
})

class FakeConnector implements Connector {
  constructor(private readonly client: AgentClient) {}

  async connect(_connection: Connection): Promise<AgentClient> {
    return this.client
  }
}

class FakeClient implements AgentClient {
  readonly created: string[] = []
  readonly switchedModels: Model[] = []
  readonly rejected: string[] = []
  readonly cancelled: string[] = []
  readonly interrupted: string[] = []
  readonly removed: string[] = []
  polls = 0
  snapshotValue: Snapshot = { hash: "clean", base: "main", files: [] }
  pendingPermissions: Array<{ id: string; action: string; resources: string[] }> = []
  pendingForms: Array<{ id: string; title: string }> = []
  private readonly sessions = new Map<
    string,
    {
      info: SessionInfo
      messages: SessionMessage[]
      resolve?: () => void
      promise: Promise<void>
    }
  >()

  async health(): Promise<{ version: string }> {
    return { version: "2.0.0-test" }
  }

  async create(_input: SessionCreate): Promise<string> {
    const sessionID = `session_${this.created.length + 1}`
    let resolve: (() => void) | undefined
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    this.sessions.set(sessionID, {
      info: { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      messages: [],
      ...(resolve === undefined ? {} : { resolve }),
      promise,
    })
    this.created.push(sessionID)
    return sessionID
  }

  async prompt(_sessionID: string, _text: string): Promise<void> {}

  async wait(sessionID: string): Promise<void> {
    await this.session(sessionID).promise
  }

  async interrupt(sessionID: string): Promise<boolean> {
    this.interrupted.push(sessionID)
    const session = this.session(sessionID)
    session.info.outcome = "interrupted"
    session.resolve?.()
    return true
  }

  async info(sessionID: string): Promise<SessionInfo> {
    return this.session(sessionID).info
  }

  async messages(sessionID: string): Promise<SessionMessage[]> {
    return this.session(sessionID).messages
  }

  async switchAgent(_sessionID: string, _agent: string): Promise<void> {}

  async switchModel(_sessionID: string, model: Model): Promise<void> {
    this.switchedModels.push(model)
  }

  async permissions(_sessionID: string): Promise<Array<{ id: string; action: string; resources: string[] }>> {
    this.polls += 1
    return this.pendingPermissions
  }

  async rejectPermission(_sessionID: string, requestID: string): Promise<void> {
    this.rejected.push(requestID)
    this.pendingPermissions = this.pendingPermissions.filter((request) => request.id !== requestID)
  }

  async forms(_sessionID: string): Promise<Array<{ id: string; title: string }>> {
    return this.pendingForms
  }

  async cancelForm(_sessionID: string, formID: string): Promise<void> {
    this.cancelled.push(formID)
    this.pendingForms = this.pendingForms.filter((form) => form.id !== formID)
  }

  async snapshot(_location: Location): Promise<Snapshot | undefined> {
    return this.snapshotValue
  }

  async remove(sessionID: string): Promise<void> {
    this.removed.push(sessionID)
    this.sessions.delete(sessionID)
  }

  finish(
    sessionID: string,
    outcome: "succeeded" | "failed" | "interrupted",
    text?: string,
    error?: { type: string; message: string },
  ): void {
    const session = this.session(sessionID)
    session.info = {
      outcome,
      cost: 0.02,
      tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 40, write: 0 } },
    }
    session.messages = [{ type: "assistant", ...(text === undefined ? {} : { text }), ...(error === undefined ? {} : { error }) }]
    session.resolve?.()
  }

  private session(sessionID: string) {
    const session = this.sessions.get(sessionID)
    if (session === undefined) throw new Error(`Unknown session: ${sessionID}`)
    return session
  }
}

async function terminal(
  coordinator: Coordinator,
  runID: string,
  state: "succeeded" | "failed" | "blocked" | "interrupted",
): Promise<Record<string, unknown>> {
  let status: Record<string, unknown> = {}
  await until(async () => {
    status = await coordinator.status({ run_id: runID, detail: "result" })
    return status.terminal === true
  })
  assert.equal(status.state, state)
  return status
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error(`Expected string, received ${typeof value}`)
  return value
}
