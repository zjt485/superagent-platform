import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { BotSandboxConfig } from '../../db/schema.js'
import type { SandboxExecResult, SandboxHandle, SandboxProvider, SandboxRunInput } from './provider.js'

const MAX_TOOL_OUTPUT = 20_000

function safeBotId(botId: string): string {
  return botId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default'
}

function buildLocalEnv(homeDir: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'LANG', 'LC_ALL', 'CI']
  const tmpDir = path.join(homeDir, '.tmp')
  return {
    ...Object.fromEntries(allowed.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))),
    ...(extra ?? {}),
    HOME: homeDir,
    USERPROFILE: homeDir,
    BOT_HOME: homeDir,
    APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
    TEMP: tmpDir,
    TMP: tmpDir,
  }
}

/**
 * Local process sandbox for development, Windows hosts, and CI tests.
 * Maintains a persistent per-Bot home directory (`<rootDir>/bots/<botId>/home`)
 * across turns and streams stdout/stderr chunks to the caller.
 */
export class LocalProcessSandboxProvider implements SandboxProvider {
  constructor(private readonly rootDir: string) {}

  homeDirFor(botId: string): string {
    return path.resolve(this.rootDir, 'bots', safeBotId(botId), 'home')
  }

  async ensureRunning(input: {
    botId: string
    workspacePath: string
    sandboxConfig?: BotSandboxConfig
  }): Promise<SandboxHandle> {
    const homeDir = this.homeDirFor(input.botId)
    await mkdir(path.join(homeDir, 'AppData', 'Roaming'), { recursive: true })
    await mkdir(path.join(homeDir, 'AppData', 'Local'), { recursive: true })
    await mkdir(path.join(homeDir, '.tmp'), { recursive: true })
    await mkdir(input.workspacePath, { recursive: true })
    return {
      mode: 'local',
      botId: input.botId,
      homeDir,
      containerId: null,
    }
  }

  async execStream(input: SandboxRunInput): Promise<SandboxExecResult> {
    const handle = await this.ensureRunning({
      botId: input.botId,
      workspacePath: input.workspacePath,
      ...(input.sandboxConfig ? { sandboxConfig: input.sandboxConfig } : {}),
    })

    return new Promise((resolve) => {
      const child = spawn(input.command, {
        cwd: path.resolve(input.workspacePath),
        shell: true,
        env: buildLocalEnv(handle.homeDir, input.env),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false

      const cleanup = () => {
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onAbort)
      }

      const finish = (exitCode: number | null) => {
        if (settled) return
        settled = true
        cleanup()
        resolve({
          exitCode,
          stdout: stdout.slice(-MAX_TOOL_OUTPUT),
          stderr: stderr.slice(-MAX_TOOL_OUTPUT),
          ...(stdout.length > MAX_TOOL_OUTPUT ? { stdoutTruncated: true } : {}),
          ...(stderr.length > MAX_TOOL_OUTPUT ? { stderrTruncated: true } : {}),
        })
      }

      const onAbort = () => {
        stderr += '\ncommand aborted'
        child.kill('SIGKILL')
        finish(null)
      }

      if (input.signal) {
        if (input.signal.aborted) {
          onAbort()
          return
        }
        input.signal.addEventListener('abort', onAbort, { once: true })
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stdout += text
        if (stdout.length > MAX_TOOL_OUTPUT * 2) stdout = stdout.slice(-MAX_TOOL_OUTPUT * 2)
        void input.onChunk?.('stdout', text)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stderr += text
        if (stderr.length > MAX_TOOL_OUTPUT * 2) stderr = stderr.slice(-MAX_TOOL_OUTPUT * 2)
        void input.onChunk?.('stderr', text)
      })
      child.on('error', (error) => {
        stderr += `\n${error.message}`
        finish(null)
      })
      child.on('close', (code) => finish(code))
      const timer = setTimeout(() => {
        stderr += `\ncommand timed out after ${input.timeoutMs}ms`
        child.kill('SIGKILL')
        finish(null)
      }, input.timeoutMs)
    })
  }

  async getVncSession(): Promise<null> {
    return null
  }
}
