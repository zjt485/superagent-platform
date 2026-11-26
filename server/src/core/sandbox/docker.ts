import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { BotSandboxConfig } from '../../db/schema.js'
import { LocalProcessSandboxProvider } from './local.js'
import type { SandboxExecResult, SandboxHandle, SandboxProvider, SandboxRunInput } from './provider.js'

const runExecFile = promisify(execFile)
const MAX_TOOL_OUTPUT = 20_000

export interface DockerSandboxOptions {
  defaultImage?: string
  defaultMemoryMb?: number
  defaultCpus?: number
  dockerBinary?: string
}

function shortBotKey(botId: string): string {
  const cleaned = botId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  return (cleaned.slice(0, 12) || 'default')
}

export function containerNameFor(botId: string): string {
  return `sa-bot-${shortBotKey(botId)}`
}

export function homeVolumeFor(botId: string): string {
  return `sa-bot-home-${shortBotKey(botId)}`
}

/**
 * Per-Bot persistent Docker container provider.
 * Each Bot receives a dedicated named container mounting a persistent `/home/bot`
 * volume plus the active ticket workspace at `/workspace`, hardened with
 * `--cap-drop=ALL`, `--security-opt=no-new-privileges`, memory and CPU caps.
 */
export class DockerSandboxProvider implements SandboxProvider {
  private readonly docker: string
  private readonly defaultImage: string
  private readonly defaultMemoryMb: number
  private readonly defaultCpus: number

  constructor(options: DockerSandboxOptions = {}) {
    this.docker = options.dockerBinary ?? 'docker'
    this.defaultImage = options.defaultImage ?? process.env.SANDBOX_IMAGE ?? 'superagent-bot-sandbox:latest'
    this.defaultMemoryMb = options.defaultMemoryMb ?? 2048
    this.defaultCpus = options.defaultCpus ?? 2
  }

  async ensureRunning(input: {
    botId: string
    workspacePath: string
    sandboxConfig?: BotSandboxConfig
  }): Promise<SandboxHandle> {
    const name = containerNameFor(input.botId)
    const volume = homeVolumeFor(input.botId)
    const image = input.sandboxConfig?.image || this.defaultImage
    const memoryMb = input.sandboxConfig?.memoryMb ?? this.defaultMemoryMb
    const cpus = input.sandboxConfig?.cpus ?? this.defaultCpus
    const network = input.sandboxConfig?.networkMode ?? 'bridge'
    const absWorkspace = path.resolve(input.workspacePath)

    const inspected = await this.inspectContainer(name)
    if (inspected === 'running') {
      return { mode: 'docker', botId: input.botId, homeDir: '/home/bot', containerId: name }
    }
    if (inspected === 'stopped') {
      await runExecFile(this.docker, ['start', name], { windowsHide: true })
      return { mode: 'docker', botId: input.botId, homeDir: '/home/bot', containerId: name }
    }

    const args = [
      'run',
      '-d',
      '--name',
      name,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--memory',
      `${memoryMb}m`,
      '--cpus',
      String(cpus),
      '--network',
      network,
      '-v',
      `${volume}:/home/bot`,
      '-v',
      `${absWorkspace}:/workspace`,
      '-w',
      '/workspace',
      image,
      'sleep',
      'infinity',
    ]
    const { stdout } = await runExecFile(this.docker, args, { windowsHide: true })
    return {
      mode: 'docker',
      botId: input.botId,
      homeDir: '/home/bot',
      containerId: stdout.trim().slice(0, 64) || name,
    }
  }

  async execStream(input: SandboxRunInput): Promise<SandboxExecResult> {
    const handle = await this.ensureRunning({
      botId: input.botId,
      workspacePath: input.workspacePath,
      ...(input.sandboxConfig ? { sandboxConfig: input.sandboxConfig } : {}),
    })
    const container = handle.containerId ?? containerNameFor(input.botId)
    const envFlags: string[] = []
    for (const [k, v] of Object.entries(input.env ?? {})) {
      if (/^[A-Z_][A-Z0-9_]*$/i.test(k)) {
        envFlags.push('-e', `${k}=${v}`)
      }
    }

    return new Promise((resolve) => {
      const child = spawn(
        this.docker,
        ['exec', '-w', '/workspace', ...envFlags, container, '/bin/sh', '-lc', input.command],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
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

  async sleep(botId: string): Promise<void> {
    const name = containerNameFor(botId)
    await runExecFile(this.docker, ['stop', '-t', '5', name], { windowsHide: true }).catch(() => {})
  }

  async getVncSession(): Promise<null> {
    return null
  }

  private async inspectContainer(name: string): Promise<'running' | 'stopped' | 'missing'> {
    try {
      const { stdout } = await runExecFile(this.docker, ['inspect', '-f', '{{.State.Running}}', name], {
        windowsHide: true,
      })
      return stdout.trim() === 'true' ? 'running' : 'stopped'
    } catch {
      return 'missing'
    }
  }
}

/**
 * Router sandbox provider that selects Docker or Local process execution
 * based on each Bot's `sandboxConfig.mode`.
 */
export function createSandboxProvider(options: {
  rootDir: string
  defaultDockerImage?: string
}): SandboxProvider {
  const local = new LocalProcessSandboxProvider(options.rootDir)
  const docker = new DockerSandboxProvider(
    options.defaultDockerImage ? { defaultImage: options.defaultDockerImage } : {},
  )
  const pick = (cfg?: BotSandboxConfig): SandboxProvider => (cfg?.mode === 'docker' ? docker : local)
  return {
    ensureRunning: (input) => pick(input.sandboxConfig).ensureRunning(input),
    execStream: (input) => pick(input.sandboxConfig).execStream(input),
    sleep: async (botId) => {
      await docker.sleep(botId).catch(() => {})
    },
    getVncSession: async () => null,
  }
}
