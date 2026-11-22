import type { Report } from '../domain/types.js'

export interface TurnContext {
  turnId: string
  projectId: string
  projectName: string
  ticketId: string
  ticketShortName: string
  ticketTitle: string
  seq: number
  worktreePath: string
  transcriptPath: string
  inputs: string[]
  model: string | null
}

/** One turn of work; implementations may fork a child process or run in-process. */
export interface Executor {
  readonly kind: string
  run(context: TurnContext): Promise<Report>
}
