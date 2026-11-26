import type { ExecutorTurnPacket } from '../agent/types.js'
import type { Report } from '../domain/types.js'

export interface TurnContext {
  turnId: string
  sessionId: string
  projectId: string
  projectName: string
  projectSlug: string
  ticketId: string
  ticketShortName: string
  ticketTitle: string
  ticketBody: string
  seq: number
  worktreePath: string
  transcriptPath: string
  inputs: string[]
  model: string | null
  prompt: string
  packet: ExecutorTurnPacket
  timeoutMs: number
  signal?: AbortSignal
  env?: Record<string, string>
  onEvent?: (event: { type: string; message?: string; payload?: unknown }) => void | Promise<void>
}

/** One turn of work; implementations may fork a child process or run in-process. */
export interface Executor {
  readonly kind: string
  run(context: TurnContext): Promise<Report>
}
