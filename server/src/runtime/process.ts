import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { RuntimeCancelledError, type AgentRuntime, type RuntimeContext, type RuntimeResult } from '../domain/runtime.js'

export interface ProcessRuntimeOptions {
  command: string
  logLimit?: number
}

/**
 * Runs an external agent entrypoint (DSH headless or a wrapper script) inside
 * the run workspace. The command is an operator-provided template; the
 * placeholders `{workspace}`, `{promptFile}`, `{runId}` and `{ticketId}` are
 * shell-quoted before substitution. The runtime contract is small: exit 0 and
 * write `.superagent/result.json` (`{summary, plan?, tokens?, cost?}`).
 */
export class ProcessRuntime implements AgentRuntime {
  readonly name = 'command'

  constructor(private readonly options: ProcessRuntimeOptions) {
    if (!options.command.trim()) throw new Error('AGENT_COMMAND must not be empty')
  }

  async run(context: RuntimeContext): Promise<RuntimeResult> {
    const promptFile = path.join(context.workspace, '.superagent', 'prompt.md')
    const resultFile = path.join(context.workspace, '.superagent', 'result.json')
    await mkdir(path.dirname(promptFile), { recursive: true })
    await writeFile(promptFile, context.prompt, 'utf8')

    const command = this.options.command
      .replaceAll('{workspace}', shellQuote(context.workspace))
      .replaceAll('{promptFile}', shellQuote(promptFile))
      .replaceAll('{runId}', shellQuote(context.runId))
      .replaceAll('{ticketId}', shellQuote(context.ticketId))

    await context.onEvent({ type: 'log', message: `spawning agent command: ${this.options.command}` })
    const child = spawn(command, {
      cwd: context.workspace,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...context.env,
        SUPERAGENT_PROJECT_ID: context.projectId,
        SUPERAGENT_TICKET_ID: context.ticketId,
        SUPERAGENT_RUN_ID: context.runId,
        SUPERAGENT_RUN_KIND: context.kind,
      },
    })

    const limit = this.options.logLimit ?? 500
    let events = 0
    const emitLine = async (line: string, stream: 'stdout' | 'stderr') => {
      const trimmed = line.trim()
      if (!trimmed) return
      events += 1
      if (events > limit) return
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
          await context.onEvent({
            type: parsed.type,
            ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
            ...(parsed.payload === undefined ? {} : { payload: parsed.payload }),
          })
          return
        }
      } catch {
        // Plain log line.
      }
      await context.onEvent({ type: stream === 'stderr' ? 'stderr' : 'log', message: trimmed.slice(0, 4000) })
    }

    const stdout = createInterface({ input: child.stdout })
    const stderr = createInterface({ input: child.stderr })
    stdout.on('line', (line) => void emitLine(line, 'stdout'))
    stderr.on('line', (line) => void emitLine(line, 'stderr'))

    let stderrTail = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000)
    })

    let timedOut = false
    const killTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, context.timeoutMs)
    const onAbort = () => child.kill('SIGKILL')
    context.signal.addEventListener('abort', onAbort, { once: true })

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }))
      child.on('error', () => resolve({ code: 1, signal: null }))
    }).finally(() => {
      clearTimeout(killTimer)
      context.signal.removeEventListener('abort', onAbort)
      stdout.close()
      stderr.close()
    })

    if (context.signal.aborted) throw new RuntimeCancelledError()
    if (timedOut) throw new Error(`agent command timed out after ${Math.round(context.timeoutMs / 1000)}s`)
    if (exit.code !== 0) {
      throw new Error(`agent command exited with code ${exit.code ?? 'null'}${stderrTail ? `: ${stderrTail.slice(-1000)}` : ''}`)
    }

    const parsed = await readResult(resultFile)
    const summary = parsed?.summary ?? `agent command finished (${events} log lines)`
    return {
      summary: String(summary).slice(0, 10_000),
      ...(typeof parsed?.plan === 'string' ? { plan: parsed.plan.slice(0, 20_000) } : {}),
      tokens: Number(parsed?.tokens ?? 0) || 0,
      cost: Number(parsed?.cost ?? 0) || 0,
    }
  }
}

async function readResult(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}
