import type { RunKind } from './status.js'

export interface RuntimeEvent {
  type: string
  message?: string
  payload?: unknown
}

export interface RuntimeContext {
  runId: string
  projectId: string
  ticketId: string
  kind: RunKind
  workspace: string
  prompt: string
  /** Extra environment for the agent process (e.g. GH_TOKEN). */
  env: Record<string, string>
  timeoutMs: number
  signal: AbortSignal
  onEvent(event: RuntimeEvent): Promise<void>
}

export interface RuntimeResult {
  summary: string
  plan?: string
  tokens: number
  cost: number
}

/** The only seam between this platform and DSH (§7.2). */
export interface AgentRuntime {
  name: string
  run(context: RuntimeContext): Promise<RuntimeResult>
}

export class RuntimeCancelledError extends Error {
  constructor() {
    super('run cancelled')
    this.name = 'RuntimeCancelledError'
  }
}
