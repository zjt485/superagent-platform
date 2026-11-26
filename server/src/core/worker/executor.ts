import type { BotSandboxConfig, BotToolPolicy, McpServerRow } from '../../db/schema.js'
import type { ExecutorTurnPacket, TurnResumeInput } from '../agent/types.js'
import type { Report } from '../domain/types.js'
import type { McpClient } from '../mcp/client.js'
import type { BrowserToolRunner } from '../sandbox/browser.js'
import type { SandboxProvider } from '../sandbox/provider.js'

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
  toolPolicy?: BotToolPolicy
  resumeFrom?: TurnResumeInput
  sandbox?: SandboxProvider
  sandboxBotId?: string
  sandboxConfig?: BotSandboxConfig
  browser?: BrowserToolRunner
  mcpServers?: McpServerRow[]
  mcpClient?: McpClient
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
