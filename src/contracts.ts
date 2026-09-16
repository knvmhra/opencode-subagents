import { z } from "zod"

const AuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bearer"), token_env: z.string().min(1) }),
  z.object({ kind: z.literal("basic"), username: z.string().min(1), password_env: z.string().min(1) }),
  z.object({ kind: z.literal("header"), name: z.string().min(1), value_env: z.string().min(1) }),
])

export const SetupSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("local"),
    directory: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    handoff: z.string().max(12_000).optional(),
  }),
  z.object({
    action: z.literal("begin"),
    intent: z.string().min(1),
    target: z.enum(["remote_server", "shell_handoff"]),
    name: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("commit"),
    context_id: z.string().min(1),
    directory: z.string().min(1),
    workspace_id: z.string().min(1).optional(),
    handoff: z.string().max(12_000).optional(),
    server_url: z.url().optional(),
    auth: AuthSchema.optional(),
  }),
])

export const StartSchema = z.object({
  context_id: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  continue_from: z.string().min(1).optional(),
  alias: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  access: z.enum(["read", "write"]).default("write"),
})

export const InterruptSchema = z.object({
  run_id: z.string().min(1),
  reason: z.string().max(1_000).optional(),
})

export const StatusSchema = z.object({
  wait: z.boolean().optional().describe("Wait for run completion without polling; requires run_id. Returns the final handoff."),
  run_id: z.string().min(1).optional(),
  detail: z.enum(["compact", "result", "diagnostic"]).default("compact"),
})

export const ReviewSchema = z.object({
  run_id: z.string().min(1),
  instructions: z.string().max(8_000).optional(),
  alias: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  allow_partial: z.boolean().default(false),
})

export type SetupInput = z.infer<typeof SetupSchema>
export type StartInput = z.infer<typeof StartSchema>
export type InterruptInput = z.infer<typeof InterruptSchema>
export type StatusInput = z.infer<typeof StatusSchema>
export type ReviewInput = z.infer<typeof ReviewSchema>
