import type { BotSandboxConfig } from '../../db/schema.js'

export interface SandboxHandle {
  mode: 'local' | 'docker'
  botId: string
  homeDir: string
  containerId: string | null
}

export interface SandboxRunInput {
  botId: string
  workspacePath: string
  command: string
  timeoutMs: number
  env?: Record<string, string>
  sandboxConfig?: BotSandboxConfig
  signal?: AbortSignal
  onChunk?: (stream: 'stdout' | 'stderr', chunk: string) => void | Promise<void>
}

export interface SandboxExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
}

export interface VncSessionInfo {
  url: string
  token: string
}

/**
 * Per-Bot persistent cloud computer abstraction.
 * V1 provides LocalProcessSandboxProvider (dev/CI) and DockerSandboxProvider
 * (containerized per-Bot workspace with persistent home volume).
 * V2 reserves `getVncSession` for interactive noVNC desktop takeover.
 */
export interface SandboxProvider {
  ensureRunning(input: {
    botId: string
    workspacePath: string
    sandboxConfig?: BotSandboxConfig
  }): Promise<SandboxHandle>
  execStream(input: SandboxRunInput): Promise<SandboxExecResult>
  sleep?(botId: string): Promise<void>
  getVncSession?(botId: string): Promise<VncSessionInfo | null>
}
