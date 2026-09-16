import { setTimeout as delay } from "node:timers/promises"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { OpenCode } from "@opencode-ai/client"
import { Service } from "@opencode-ai/client/service"
import { Agent, type Dispatcher } from "undici"
import type { Config, Connection, Location, Model, RemoteAuth, SessionCreate, Snapshot } from "./types.js"
import { BridgeError, type AgentClient, type Connector, type SessionInfo, type SessionMessage } from "./types.js"
import { clearServiceMarker, markServiceStartedByBridge, otherLiveBridgeSessions, serviceStartedByBridge } from "./dashfile.js"

type Client = ReturnType<typeof OpenCode.make>

// Fetch may supply its own five-minute limits, overriding Agent defaults.
// Enforce unlimited idle time only for session.wait at the dispatch boundary.
export function sessionWaitDispatcher(dispatcher: Dispatcher): Pick<Dispatcher, "dispatch"> {
  return {
    dispatch(options, handler) {
      return dispatcher.dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler)
    },
  }
}
const waitDispatcher = sessionWaitDispatcher(new Agent())
const sessionFetch: typeof globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (!/^\/api\/session\/[^/]+\/wait$/.test(url.pathname)) return globalThis.fetch(input, init)
  const options = { ...init, dispatcher: waitDispatcher }
  // Node and the installed Undici expose different dispatcher TypeScript versions.
  return globalThis.fetch(input, options as unknown as NonNullable<Parameters<typeof globalThis.fetch>[1]>)
}

export class OpenCodeConnector implements Connector {
  /** True once ensure() decided to spawn or replace the local service in this process. */
  private started = false
  /** True once this process connected to the shared local service at all. */
  private usedLocal = false
  /** The in-flight ensure(), so shutdown cannot race a service that spawned but has not registered yet. */
  private ensuring: Promise<unknown> = Promise.resolve()

  constructor(private readonly config: Config) {}

  get startedService(): boolean {
    return this.started
  }

  async connect(connection: Connection): Promise<AgentClient> {
    if (connection.target === "remote_server") {
      const client = new OpenCodeAgent(OpenCode.make({ baseUrl: connection.url, headers: headers(connection.auth), fetch: sessionFetch }))
      await client.health()
      return client
    }

    const bundled = this.config.service.command[0] === "opencode2"
    this.usedLocal = true
    const ensuring = Service.ensure({
      command: serviceCommand(this.config.service.command),
      version: bundled ? bundledVersion : compatible,
      onStart: () => {
        this.started = true
        markServiceStartedByBridge()
      },
    })
    this.ensuring = ensuring.then(
      () => undefined,
      () => undefined,
    )
    const endpoint = await ensuring
    const client = new OpenCodeAgent(OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint), fetch: sessionFetch }))
    await client.health()
    return client
  }

  /**
   * Stop the local OpenCode service only when this process started it. The service is a
   * singleton that may be shared with the user's own opencode2 session, so an unconditional
   * stop could kill a daemon this process does not own. Service.stop() re-reads the
   * registration file, so if another instance replaced ours in the meantime the replacement
   * is what gets stopped; the vendor exposes no pid from ensure() to do better.
   */
  async stopService(): Promise<void> {
    if (!this.usedLocal) return
    await this.ensuring
    if (otherLiveBridgeSessions()) {
      // Last one out stops the daemon; another live bridge session still needs it.
      if (this.started) console.error("[opencode-subagents] leaving the shared OpenCode service for other live bridge sessions")
      return
    }
    // Never stop a daemon no bridge process started (e.g. the user's own opencode2 session).
    if (!this.started && !serviceStartedByBridge()) return
    await Service.stop()
    clearServiceMarker()
  }
}

export class OpenCodeAgent implements AgentClient {
  constructor(private readonly client: Client) {}

  async health(): Promise<{ version: string }> {
    const health = await this.client.health.get()
    return { version: health.version }
  }

  async create(input: SessionCreate): Promise<string> {
    const session = await this.client.session.create({
      title: input.title,
      location: input.location,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    })
    return session.id
  }

  async prompt(sessionID: string, text: string): Promise<void> {
    await this.client.session.prompt({ sessionID, text, delivery: "queue", resume: true })
  }

  async wait(sessionID: string, signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted()
      try {
        await this.client.session.wait({ sessionID }, signal === undefined ? undefined : { signal })
        return
      } catch (error) {
        // A timed-out HTTP observer does not mean the session stopped. Reattach
        // without resubmitting the prompt or releasing the context's writer.
        if (!waitTimedOut(error) || signal?.aborted) throw error
        await delay(250, undefined, signal === undefined ? undefined : { signal })
      }
    }
  }

  async interrupt(sessionID: string): Promise<boolean> {
    return (await this.client.session.interrupt({ sessionID, continue: false })).interrupted
  }

  async info(sessionID: string): Promise<SessionInfo> {
    const session = await this.client.session.get({ sessionID })
    return {
      ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
      cost: session.cost,
      tokens: session.tokens,
    }
  }

  async messages(sessionID: string): Promise<SessionMessage[]> {
    return (await this.client.session.context({ sessionID })).flatMap((message) => {
      if (message.type !== "assistant") return []
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim()
      return [
        {
          type: message.type,
          ...(text.length === 0 ? {} : { text }),
          ...(message.error === undefined
            ? {}
            : { error: { type: message.error.type, message: message.error.message } }),
        },
      ]
    })
  }

  async switchAgent(sessionID: string, agent: string): Promise<void> {
    await this.client.session.switchAgent({ sessionID, agent })
  }

  async switchModel(sessionID: string, model: Model): Promise<void> {
    await this.client.session.switchModel({ sessionID, model })
  }

  async permissions(sessionID: string): Promise<Array<{ id: string; action: string; resources: string[] }>> {
    return (await this.client.permission.list({ sessionID })).map((request) => ({
      id: request.id,
      action: request.action,
      resources: request.resources,
    }))
  }

  async rejectPermission(sessionID: string, requestID: string): Promise<void> {
    await this.client.permission.reply({
      sessionID,
      requestID,
      reply: "reject",
      message: "This delegated run is non-interactive. Return a concise blocked result instead of requesting approval.",
    })
  }

  async forms(sessionID: string): Promise<Array<{ id: string; title: string }>> {
    return (await this.client.form.list({ sessionID })).map((form) => ({ id: form.id, title: form.title }))
  }

  async cancelForm(sessionID: string, formID: string): Promise<void> {
    await this.client.form.cancel({ sessionID, formID })
  }

  async snapshot(location: Location): Promise<Snapshot | undefined> {
    const query = {
      location: {
        directory: location.directory,
        ...(location.workspaceID === undefined ? {} : { workspace: location.workspaceID }),
      },
    }
    try {
      const [base, status, diff] = await Promise.all([
        this.client.vcs.base(query),
        this.client.vcs.status(query),
        this.client.vcs.diff({ ...query, mode: "working", context: 0 }),
      ])
      const data = {
        base: base.data?.ref,
        status: status.data
          .map((file) => ({ file: file.file, status: file.status, additions: file.additions, deletions: file.deletions }))
          .sort((a, b) => a.file.localeCompare(b.file)),
        diff: diff.data
          .map((file) => ({ file: file.file, status: file.status, patch: file.patch }))
          .sort((a, b) => a.file.localeCompare(b.file)),
      }
      return {
        hash: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
        ...(data.base === undefined ? {} : { base: data.base }),
        files: data.status.map((file) => file.file),
      }
    } catch {
      return undefined
    }
  }

  async remove(sessionID: string): Promise<void> {
    await this.client.session.remove({ sessionID })
  }
}

const require = createRequire(import.meta.url)
const cliPackageFile = require.resolve("@opencode-ai/cli/package.json")
export const bundledVersion = (require(cliPackageFile) as { version: string }).version

/** Use the client-compatible CLI shipped with this package unless the user explicitly chose another command. */
export function serviceCommand(command: string[]): string[] {
  if (command[0] !== "opencode2") return command
  return [join(dirname(cliPackageFile), "bin", "opencode2.exe"), ...command.slice(1)]
}

function compatible(version: string): boolean {
  return version.startsWith("2.") || version.includes("next") || version.includes("beta") || version.startsWith("0.0.0-")
}

function headers(auth?: RemoteAuth): Record<string, string> | undefined {
  if (auth === undefined) return undefined
  if (auth.kind === "bearer") return { authorization: `Bearer ${secret(auth.tokenEnv)}` }
  if (auth.kind === "basic") {
    return { authorization: `Basic ${Buffer.from(`${auth.username}:${secret(auth.passwordEnv)}`).toString("base64")}` }
  }
  return { [auth.name]: secret(auth.valueEnv) }
}

function secret(name: string): string {
  const value = process.env[name]
  if (value === undefined) throw new BridgeError("missing_secret", `Environment variable ${name} is not set`)
  return value
}

function waitTimedOut(error: unknown): boolean {
  const seen = new Set<unknown>()
  while (error !== null && typeof error === "object" && !seen.has(error)) {
    seen.add(error)
    const value = error as { code?: string; cause?: unknown }
    if (value.code === "UND_ERR_HEADERS_TIMEOUT" || value.code === "UND_ERR_BODY_TIMEOUT") return true
    error = value.cause
  }
  return false
}
