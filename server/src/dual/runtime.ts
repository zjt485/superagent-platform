import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { Config } from '../config.js'
import type { Logger } from '../logger.js'
import { shortId } from '../domain/ids.js'
import { ticketTitle } from '../domain/message.js'
import type { ExecutorReportOutput, ExecutorTurnPacket, MainDecisionOutput, MainTurnPacket, TurnRuntime, TurnRuntimeInput, TurnRuntimeResult } from './types.js'
import { TurnCancelledError } from './types.js'
import { OpenAiTurnRuntime } from './openai.js'

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new TurnCancelledError())
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new TurnCancelledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Deterministic dual-agent runtime for demos/tests. It follows the same wire
 * protocol as the real command runtime so the engine is exercised end to end.
 */
export class FakeTurnRuntime implements TurnRuntime {
  readonly name = 'fake-dual'

  constructor(private readonly options: { delayMs?: number; executorFail?: boolean } = {}) {}

  async run(input: TurnRuntimeInput): Promise<TurnRuntimeResult> {
    const delay = this.options.delayMs ?? 10
    await input.onEvent({ type: 'turn', message: `${input.role} turn started` })
    await sleep(delay, input.signal)

    if (input.role === 'main') {
      const packet = input.packet as MainTurnPacket
      const decisions: MainDecisionOutput['decisions'] = packet.thread.triggers.map((trigger) => {
        if (trigger.isBot || !trigger.mentionedBot) {
          return { action: 'ignore' as const, triggerId: trigger.id, reason: 'not an explicit @bot request' }
        }
        const title = ticketTitle(trigger.text)
        return {
          action: 'accept' as const,
          triggerId: trigger.id,
          reason: 'explicit @bot request from a project member',
          reply: `已接单：${title}`,
          ticket: {
            title,
            body: trigger.text,
            scope: `完成「${title}」并提交可评审的改动，不得修改项目策略或权限。`,
            strength: 'explicit' as const,
            planApproval: (packet.project.policy.planApproval as 'required' | 'auto' | undefined) ?? 'auto',
          },
        }
      })
      if (decisions.length === 0) {
        decisions.push({ action: 'ignore', triggerId: 'none', reason: 'empty trigger batch' })
      }
      await input.onEvent({ type: 'decision', message: `accepted ${decisions.filter((decision) => decision.action === 'accept').length} trigger(s)` })
      return { output: { decisions }, tokens: 300, cost: 0.0004 }
    }

    const packet = input.packet as ExecutorTurnPacket
    const planRequired = packet.project.policy.planApproval === 'required'
    if (planRequired && !packet.ticket.planApproved && !packet.ticket.plan) {
      const plan = [
        `1. 阅读仓库，定位「${packet.ticket.title}」相关代码。`,
        '2. 按需求实现改动并补充测试。',
        '3. 运行仓库现有验证命令。',
        '4. 提交到 agent 分支并创建 PR。',
      ].join('\n')
      await input.onEvent({ type: 'plan', message: plan })
      const report: ExecutorReportOutput = { status: 'progress', summary: '已生成实施计划，等待 Maintainer 批准。', plan }
      return { output: report, tokens: 320, cost: 0.0004 }
    }

    if (this.options.executorFail) {
      await input.onEvent({ type: 'error', message: 'fake executor failure requested' })
      throw new Error('fake executor failure requested')
    }

    if (!input.workspace) {
      const report: ExecutorReportOutput = { status: 'failed', summary: '没有可用的工作区' }
      return { output: report, tokens: 10, cost: 0 }
    }

    const relative = path.join('docs', 'superagent', `ticket-${shortId(packet.ticket.id)}.md`)
    const absolute = path.join(input.workspace, relative)
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(
      absolute,
      [
        '# Superagent 变更说明',
        '',
        `- 工单：${packet.ticket.id}`,
        `- 标题：${packet.ticket.title}`,
        `- 输入：${packet.inputs.map((item) => item.text).join(' / ') || '首次执行'}`,
        `- 时间：${new Date().toISOString()}`,
        '',
      ].join('\n'),
      'utf8',
    )
    await input.onEvent({ type: 'file', message: relative })
    const report: ExecutorReportOutput = {
      status: 'ready',
      summary: `新增 ${relative}，完成「${packet.ticket.title}」。`,
    }
    return { output: report, tokens: 1200 + Math.floor(input.prompt.length / 4), cost: 0.0018 }
  }
}

/** Runs an external agent command; the same `.superagent/result.json` contract. */
export class ProcessTurnRuntime implements TurnRuntime {
  readonly name = 'command-dual'

  constructor(private readonly command: string, private readonly logLimit = 500) {}

  async run(input: TurnRuntimeInput): Promise<TurnRuntimeResult> {
    if (!input.workspace) throw new Error('command runtime requires a workspace')
    const dir = path.join(input.workspace, '.superagent')
    const promptFile = path.join(dir, 'prompt.md')
    const inputFile = path.join(dir, 'input.json')
    const resultFile = path.join(dir, 'result.json')
    await mkdir(dir, { recursive: true })
    await writeFile(promptFile, input.prompt, 'utf8')
    await writeFile(inputFile, JSON.stringify(input.packet, null, 2), 'utf8')
    await writeFile(resultFile, '', 'utf8')

    const command = this.command
      .replaceAll('{workspace}', shellQuote(input.workspace))
      .replaceAll('{promptFile}', shellQuote(promptFile))
      .replaceAll('{inputFile}', shellQuote(inputFile))
      .replaceAll('{resultFile}', shellQuote(resultFile))
      .replaceAll('{turnId}', shellQuote(input.turnId))
      .replaceAll('{ticketId}', shellQuote(input.ticketId ?? ''))

    const child = spawn(command, {
      cwd: input.workspace,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...input.env,
        SUPERAGENT_ROLE: input.role,
        SUPERAGENT_PROJECT_ID: input.projectId,
        SUPERAGENT_SESSION_ID: input.sessionId,
        SUPERAGENT_TURN_ID: input.turnId,
        SUPERAGENT_TICKET_ID: input.ticketId ?? '',
        SUPERAGENT_INPUT_FILE: inputFile,
        SUPERAGENT_RESULT_FILE: resultFile,
      },
    })

    let count = 0
    const emit = async (line: string, stream: 'stdout' | 'stderr') => {
      const text = line.trim()
      if (!text || count >= this.logLimit) return
      count += 1
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
          await input.onEvent({
            type: parsed.type,
            ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
            ...(parsed.payload === undefined ? {} : { payload: parsed.payload }),
          })
          return
        }
      } catch {
        // plain log line
      }
      await input.onEvent({ type: stream === 'stderr' ? 'stderr' : 'log', message: text.slice(0, 4000) })
    }
    const stdout = createInterface({ input: child.stdout })
    const stderr = createInterface({ input: child.stderr })
    stdout.on('line', (line) => void emit(line, 'stdout'))
    stderr.on('line', (line) => void emit(line, 'stderr'))

    let timedOut = false
    const killTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, input.timeoutMs)
    const onAbort = () => child.kill('SIGKILL')
    input.signal.addEventListener('abort', onAbort, { once: true })
    const exit = await new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code))
      child.on('error', () => resolve(1))
    }).finally(() => {
      clearTimeout(killTimer)
      input.signal.removeEventListener('abort', onAbort)
      stdout.close()
      stderr.close()
    })
    if (input.signal.aborted) throw new TurnCancelledError()
    if (timedOut) throw new Error(`agent command timed out after ${Math.round(input.timeoutMs / 1000)}s`)
    if (exit !== 0) throw new Error(`agent command exited with code ${exit}`)

    const raw = await readFile(resultFile, 'utf8').catch(() => '')
    if (!raw.trim()) throw new Error('agent command did not write .superagent/result.json')
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw new Error('agent command wrote invalid result.json')
    }
    const output = parsed.output ?? parsed
    return {
      output,
      tokens: Number(parsed.tokens ?? 0) || 0,
      cost: Number(parsed.cost ?? 0) || 0,
      ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
    }
  }
}

export function createTurnRuntime(config: Config, log: Logger): TurnRuntime {
  if (config.AGENT_RUNTIME === 'command') {
    if (!config.AGENT_COMMAND) throw new Error('AGENT_COMMAND is required when AGENT_RUNTIME=command')
    return new ProcessTurnRuntime(config.AGENT_COMMAND)
  }
  if (config.AGENT_RUNTIME === 'openai') {
    if (!config.LLM_API_KEY) throw new Error('LLM_API_KEY is required when AGENT_RUNTIME=openai')
    log.info({ baseUrl: config.LLM_BASE_URL, model: config.LLM_MODEL }, 'openai-compatible runtime enabled')
    return new OpenAiTurnRuntime({
      baseUrl: config.LLM_BASE_URL,
      apiKey: config.LLM_API_KEY,
      model: config.LLM_MODEL,
      temperature: config.LLM_TEMPERATURE,
      maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
      maxSteps: config.LLM_MAX_STEPS,
      inputCostPer1M: config.LLM_INPUT_COST_PER_1M,
      outputCostPer1M: config.LLM_OUTPUT_COST_PER_1M,
    })
  }
  if (config.NODE_ENV === 'production') log.warn('fake dual-agent runtime enabled in production')
  return new FakeTurnRuntime()
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}
