import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { Config, Model, Profile } from "./types.js"
import { BridgeError } from "./types.js"

const ProfileSchema = z.object({
  model: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  instructions: z.string().optional(),
})

const ConfigSchema = z.object({
  aliases: z.record(z.string(), ProfileSchema).default({}),
  defaults: z
    .object({
      worker: z.string().min(1).default("worker"),
      reviewer: z.string().min(1).default("reviewer"),
    })
    .default({ worker: "worker", reviewer: "reviewer" }),
  service: z
    .object({
      command: z.array(z.string().min(1)).min(1).default(["opencode2", "serve", "--service"]),
    })
    .default({ command: ["opencode2", "serve", "--service"] }),
})

const builtins: Config = {
  aliases: {
    worker: { agent: "build" },
    reviewer: { agent: "plan" },
  },
  defaults: { worker: "worker", reviewer: "reviewer" },
  service: { command: ["opencode2", "serve", "--service"] },
}

export async function loadConfig(path = process.env["OPENCODE_SUBAGENTS_CONFIG"]): Promise<Config> {
  const file = path ?? join(homedir(), ".config", "opencode-subagents", "config.json")
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return builtins
  const parsed = ConfigSchema.parse(JSON.parse(text))
  return {
    aliases: { ...builtins.aliases, ...parsed.aliases },
    defaults: parsed.defaults,
    service: parsed.service,
  }
}

export function profile(
  config: Config,
  purpose: "worker" | "reviewer",
  alias?: string,
  model?: string,
  agent?: string,
): { alias: string; profile: Profile; model?: Model; agent?: string } {
  const name = alias ?? config.defaults[purpose]
  const selected = config.aliases[name]
  if (selected === undefined && model === undefined && agent === undefined) {
    throw new BridgeError("unknown_alias", `Unknown model alias: ${name}`)
  }
  const resolved = selected ?? {}
  const spec = model ?? resolved.model
  const selectedAgent = agent ?? resolved.agent
  return {
    alias: name,
    profile: resolved,
    ...(spec === undefined ? {} : { model: parseModel(spec) }),
    ...(selectedAgent === undefined ? {} : { agent: selectedAgent }),
  }
}

export function parseModel(spec: string): Model {
  const slash = spec.indexOf("/")
  if (slash < 1 || slash === spec.length - 1) {
    throw new BridgeError("invalid_model", `Model must use provider/model syntax: ${spec}`)
  }
  const hash = spec.lastIndexOf("#")
  const variant = hash > slash ? spec.slice(hash + 1) : undefined
  const id = spec.slice(slash + 1, hash > slash ? hash : undefined)
  if (id.length === 0 || variant === "") throw new BridgeError("invalid_model", `Invalid model: ${spec}`)
  return {
    providerID: spec.slice(0, slash),
    id,
    ...(variant === undefined ? {} : { variant }),
  }
}
