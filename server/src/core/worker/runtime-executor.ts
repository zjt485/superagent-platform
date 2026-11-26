import type { TurnRuntime, TurnRuntimeInput } from '../agent/types.js'
import type { Report, ReportStatus } from '../domain/types.js'
import type { Executor, TurnContext } from './executor.js'

const REPORT_STATUSES: ReadonlySet<string> = new Set([
  'progress',
  'waiting',
  'ready',
  'blocked',
  'failed',
  'dropped',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Normalize one runtime output into the core Report contract. */
export function reportFromRuntime(output: unknown, tokens: number, cost: number): Report {
  const record = isRecord(output) ? output : {}
  const statusValue = record.status
  const status: ReportStatus =
    typeof statusValue === 'string' && REPORT_STATUSES.has(statusValue) ? (statusValue as ReportStatus) : 'failed'
  const summary = stringOrUndefined(record.summary) ?? (status === 'failed' ? 'runtime returned an invalid report' : 'runtime finished')
  const changedFiles = Array.isArray(record.changedFiles)
    ? record.changedFiles.filter((item): item is string => typeof item === 'string')
    : undefined
  const rawHandoff = isRecord(record.handoff) ? record.handoff : null
  const toBotSlug = rawHandoff ? stringOrUndefined(rawHandoff.toBotSlug) : undefined
  const handoff =
    rawHandoff && toBotSlug
      ? {
          toBotSlug,
          summary: stringOrUndefined(rawHandoff.summary) ?? summary,
          context: stringOrUndefined(rawHandoff.context) ?? summary,
          ...(stringOrUndefined(rawHandoff.expectedOutput) ? { expectedOutput: stringOrUndefined(rawHandoff.expectedOutput) } : {}),
        }
      : undefined

  return {
    status,
    summary,
    ...(stringOrUndefined(record.plan) === undefined ? {} : { plan: stringOrUndefined(record.plan) }),
    ...(stringOrUndefined(record.attentionQuestion) === undefined && stringOrUndefined(record.attention) === undefined
      ? {}
      : { attentionQuestion: stringOrUndefined(record.attentionQuestion) ?? stringOrUndefined(record.attention) }),
    ...(stringOrUndefined(record.branch) === undefined ? {} : { branch: stringOrUndefined(record.branch) }),
    ...(stringOrUndefined(record.prUrl) === undefined ? {} : { prUrl: stringOrUndefined(record.prUrl) }),
    ...(changedFiles === undefined ? {} : { changedFiles }),
    ...(handoff === undefined ? {} : { handoff }),
    tokens,
    cost,
    raw: output,
  }
}

/** Execute a turn with one of the platform runtimes (command, OpenAI, fake). */
export class RuntimeExecutor implements Executor {
  readonly kind = 'runtime'

  constructor(
    private readonly runtime: TurnRuntime,
    private readonly onEvent?: (event: { type: string; message?: string; payload?: unknown }) => void | Promise<void>,
  ) {}

  async run(context: TurnContext): Promise<Report> {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (context.signal !== undefined) {
      if (context.signal.aborted) controller.abort()
      else context.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const input: TurnRuntimeInput = {
        role: 'executor',
        projectId: context.projectId,
        sessionId: context.sessionId,
        turnId: context.turnId,
        ticketId: context.ticketId,
        workspace: context.worktreePath,
        prompt: context.prompt,
        packet: context.packet,
        timeoutMs: context.timeoutMs,
        signal: controller.signal,
        env: context.env ?? {},
        onEvent: async (event) => {
          await context.onEvent?.(event)
          await this.onEvent?.(event)
        },
      }
      const result = await this.runtime.run(input)
      return reportFromRuntime(result.output, result.tokens, result.cost)
    } finally {
      context.signal?.removeEventListener('abort', onAbort)
    }
  }
}
