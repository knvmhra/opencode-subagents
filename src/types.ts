export type Access = "read" | "write"

export type Target = "local" | "remote_server" | "shell_handoff"

export type RunState =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "interrupting"
  | "interrupted"

export type FailureKind =
  | "funds_exhausted"
  | "budget_exceeded"
  | "rate_limited"
  | "authentication_failed"
  | "provider_unavailable"
  | "context_exhausted"
  | "permission_denied"
  | "interrupted"
  | "unknown_provider_error"

export type Model = {
  providerID: string
  id: string
  variant?: string
}

export type Profile = {
  model?: string | undefined
  agent?: string | undefined
  instructions?: string | undefined
}

export type Config = {
  aliases: Record<string, Profile>
  defaults: {
    worker: string
    reviewer: string
  }
  service: {
    command: string[]
  }
}

export type RemoteAuth =
  | { kind: "bearer"; tokenEnv: string }
  | { kind: "basic"; username: string; passwordEnv: string }
  | { kind: "header"; name: string; valueEnv: string }

export type Connection =
  | { target: "local" | "shell_handoff" }
  | { target: "remote_server"; url: string; auth?: RemoteAuth }

export type Location = {
  directory: string
  workspaceID?: string
}

export type Context = {
  id: string
  name?: string
  state: "pending" | "ready"
  target: Target
  intent?: string
  directory?: string
  workspaceID?: string
  handoff?: string
  connection?: Connection
  client?: AgentClient
  writer?: string
  createdAt: number
}

export type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
  }
}

export type Failure = {
  kind: FailureKind
  message: string
  type?: string
}

export type Snapshot = {
  hash: string
  base?: string
  files: string[]
}

export type Run = {
  id: string
  kind: "work" | "review"
  contextID: string
  sourceRunID?: string
  sessionID: string
  task: string
  access: Access
  alias: string
  agent?: string
  model?: Model
  state: RunState
  startedAt: number
  finishedAt?: number
  baseline?: Snapshot | undefined
  result?: string
  verdict?: "pass" | "fail" | "blocked"
  failure?: Failure
  usage?: Usage
  snapshot?: Snapshot
  blockers: string[]
}

export type SessionInfo = {
  outcome?: "succeeded" | "failed" | "interrupted"
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

export type SessionMessage = {
  type: string
  text?: string
  error?: { type: string; message: string }
}

export type SessionCreate = {
  location: Location
  title: string
  agent?: string
  model?: Model
  metadata?: Record<string, string | number | boolean>
}

export interface AgentClient {
  health(): Promise<{ version: string }>
  create(input: SessionCreate): Promise<string>
  prompt(sessionID: string, text: string): Promise<void>
  wait(sessionID: string, signal?: AbortSignal): Promise<void>
  interrupt(sessionID: string): Promise<boolean>
  info(sessionID: string): Promise<SessionInfo>
  messages(sessionID: string): Promise<SessionMessage[]>
  switchAgent(sessionID: string, agent: string): Promise<void>
  switchModel(sessionID: string, model: Model): Promise<void>
  permissions(sessionID: string): Promise<Array<{ id: string; action: string; resources: string[] }>>
  rejectPermission(sessionID: string, requestID: string): Promise<void>
  forms(sessionID: string): Promise<Array<{ id: string; title: string }>>
  cancelForm(sessionID: string, formID: string): Promise<void>
  snapshot(location: Location): Promise<Snapshot | undefined>
  remove(sessionID: string): Promise<void>
}

export interface Connector {
  connect(connection: Connection): Promise<AgentClient>
}

export class BridgeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "BridgeError"
    this.code = code
  }
}
