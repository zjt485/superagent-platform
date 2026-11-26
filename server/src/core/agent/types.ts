import { z } from 'zod'

/**
 * Wire protocols between the platform and the agent runtime. External command
 * runtimes write the same shape to `.superagent/result.json`; the OpenAI and
 * fake runtimes produce it in-process.
 */

export const EXECUTOR_REPORT_OUTPUT = z.object({
  status: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']),
  summary: z.string().max(6000).default(''),
  plan: z.string().max(20_000).optional(),
  attention: z.object({ question: z.string().trim().min(1).max(1000) }).optional(),
  branch: z.string().max(200).optional(),
  changedFiles: z.array(z.string()).optional(),
  tokens: z.number().int().min(0).optional(),
  cost: z.number().min(0).optional(),
})

export type ExecutorReportOutput = z.infer<typeof EXECUTOR_REPORT_OUTPUT>

export interface TriggerCard {
  id: string
  kind: string
  text: string
  actorName: string | null
  actorUserId: string | null
  isBot: boolean
  mentionedBot: boolean
  threadKey: string | null
  createdAt: string
}

export interface TicketCard {
  id: string
  title: string
  stage: string | null
  status: string
  summary: string | null
  plan: string | null
  prUrl: string | null
  updatedAt: string
}

export interface MainTurnPacket {
  role: 'main'
  project: {
    id: string
    name: string
    slug: string
    policyVersion: string
    policy: Record<string, unknown>
  }
  channel: { id: string; provider: string; name: string | null; chatId: string } | null
  thread: { key: string; triggers: TriggerCard[] }
  tickets: TicketCard[]
  transcript: { role: string; content: string }[]
}

export interface ExecutorTurnPacket {
  role: 'executor'
  project: {
    id: string
    name: string
    slug: string
    policyVersion: string
    policy: Record<string, unknown>
  }
  ticket: {
    id: string
    title: string
    body: string
    plan: string | null
    planApproved: boolean
    branch: string | null
    prUrl: string | null
    requesterName: string | null
  }
  mandate: {
    scope: string
    strength: string
    policyVersion: string
    matchedRules: string[]
  }
  inputs: { id: string; source: string; text: string; isPerson: boolean; createdAt: string }[]
  latestReport: {
    status: string
    summary: string
    plan: string | null
    attention: string | null
  } | null
  transcript: { role: string; content: string }[]
  workspaceReady: boolean
}

export interface TurnRuntimeInput {
  role: 'main' | 'executor'
  projectId: string
  sessionId: string
  turnId: string
  ticketId?: string | null
  workspace?: string
  prompt: string
  packet: MainTurnPacket | ExecutorTurnPacket
  timeoutMs: number
  signal: AbortSignal
  env: Record<string, string>
  onEvent(event: { type: string; message?: string; payload?: unknown }): Promise<void>
}

export interface TurnRuntimeResult {
  output: unknown
  tokens: number
  cost: number
  summary?: string
}

export interface TurnRuntime {
  name: string
  run(input: TurnRuntimeInput): Promise<TurnRuntimeResult>
}

export class TurnCancelledError extends Error {
  constructor() {
    super('turn cancelled')
    this.name = 'TurnCancelledError'
  }
}
