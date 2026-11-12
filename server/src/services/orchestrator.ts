import { eq } from 'drizzle-orm'
import type { Deps } from './deps.js'
import type { QueuePort } from '../domain/queue.js'
import { projects, runs, tickets, type ProjectRow, type RunRow, type TicketRow } from '../db/schema.js'
import { conflict, notFound } from '../errors.js'
import { parsePolicy } from '../domain/policy.js'
import type { RunKind } from '../domain/status.js'
import { audit } from './audit.js'
import { notifications } from './notifications.js'
import { activeRunForTicket, createRun, finishRun, findStaleRuns } from './runs.js'
import {
  approveTicketPlan,
  getTicketById,
  markPlanReady,
  markTicketCancelled,
  markTicketDone,
  markTicketFailed,
  markWaitingReview,
  retryKind,
  setTicketStatus,
} from './tickets.js'
import { tokensUsedToday } from './usage.js'

export interface OrchestratorContext extends Deps {
  queue: QueuePort
}

export async function projectForTicket(deps: Deps, ticket: TicketRow): Promise<ProjectRow> {
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, ticket.projectId))
  if (!project) throw notFound('项目不存在')
  return project
}

export function ensureProjectActive(project: ProjectRow): void {
  if (project.status !== 'active') throw conflict(`项目当前为 ${project.status}，不能启动新的运行`)
}

/**
 * Wake a worker. A queue outage must not fail the business change: the run row
 * is already persisted and the DB-based worker loop (or the orphan poller) will
 * pick it up.
 */
async function wake(ctx: OrchestratorContext, runId: string): Promise<void> {
  try {
    await ctx.queue.notify(runId)
  } catch (error) {
    ctx.log.warn({ err: error, runId }, 'failed to notify queue; run will be polled from the database')
  }
}

export async function ensureBudget(deps: Deps, project: ProjectRow): Promise<void> {
  const policy = parsePolicy(project.policyJson)
  if (policy.dailyTokenBudget <= 0) return
  const used = await tokensUsedToday(deps, project.id)
  if (used >= policy.dailyTokenBudget) {
    throw conflict(`项目今日 token 预算已用完（${used}/${policy.dailyTokenBudget}）`)
  }
}

/** Creates the plan run, moves `new` to `triaged`, and wakes a worker. */
export async function enqueuePlan(ctx: OrchestratorContext, ticket: TicketRow): Promise<RunRow> {
  const project = await projectForTicket(ctx, ticket)
  ensureProjectActive(project)
  await ensureBudget(ctx, project)
  if (ticket.status === 'new') {
    ticket = await setTicketStatus(ctx, ticket, 'triaged', { updatedAt: ctx.now() })
  }
  const run = await createRun(ctx, { projectId: ticket.projectId, ticketId: ticket.id, kind: 'plan' })
  await wake(ctx, run.id)
  return run
}

/** Creates the execute run and moves the ticket to `running`. */
export async function enqueueExecution(ctx: OrchestratorContext, ticket: TicketRow): Promise<RunRow> {
  const project = await projectForTicket(ctx, ticket)
  ensureProjectActive(project)
  await ensureBudget(ctx, project)
  const run = await createRun(ctx, { projectId: ticket.projectId, ticketId: ticket.id, kind: 'execute' })
  const fresh = await getTicketById(ctx, ticket.id)
  const previous = fresh.status
  if (previous !== 'running') {
    await setTicketStatus(ctx, fresh, 'running', { updatedAt: ctx.now(), closedAt: null })
  }
  await notifications.executionStarted(ctx, { ...fresh, status: 'running', lastRunId: run.id })
  await wake(ctx, run.id)
  return run
}

/** Records a maintainer's plan approval and immediately starts the execute run. */
export async function approvePlanAndExecute(
  ctx: OrchestratorContext,
  ticketId: string,
  actor: { id: string; name: string; isAdmin: boolean },
  comment?: string,
): Promise<RunRow> {
  const ticket = await approveTicketPlan(ctx, (await getTicketById(ctx, ticketId)).projectId, ticketId, actor, comment)
  const run = await enqueueExecution(ctx, ticket)
  await audit(ctx, {
    projectId: ticket.projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'ticket.approved_and_started',
    target: `ticket:${ticketId}`,
    metadata: { runId: run.id },
  })
  return run
}

/** A thread reply on a reviewed/done ticket reopens it and starts another run. */
export async function resumeTicket(ctx: OrchestratorContext, ticketId: string, replyText: string): Promise<RunRow | null> {
  const ticket = await getTicketById(ctx, ticketId)
  if (ticket.status === 'running' || ticket.status === 'new' || ticket.status === 'triaged' || ticket.status === 'planned') {
    return null
  }
  const active = await activeRunForTicket(ctx, ticketId)
  if (active) return null
  const project = await projectForTicket(ctx, ticket)
  ensureProjectActive(project)
  await ensureBudget(ctx, project)
  const run = await createRun(ctx, { projectId: ticket.projectId, ticketId, kind: 'execute' })
  await setTicketStatus(ctx, ticket, 'running', { updatedAt: ctx.now(), closedAt: null })
  await notifications.resumed(ctx, { ...ticket, lastRunId: run.id }, replyText.slice(0, 500))
  await wake(ctx, run.id)
  return run
}

export async function cancelTicket(
  ctx: OrchestratorContext,
  ticketId: string,
  actor: { id: string; name: string; isAdmin: boolean },
): Promise<TicketRow> {
  const ticket = await getTicketById(ctx, ticketId)
  const row = await markTicketCancelled(ctx, ticket, actor)
  await notifications.cancelled(ctx, row, actor.name)
  return row
}

export async function retryTicket(
  ctx: OrchestratorContext,
  ticketId: string,
  actor: { id: string; name: string; isAdmin: boolean },
): Promise<RunRow> {
  const ticket = await getTicketById(ctx, ticketId)
  if (ticket.status !== 'failed' && ticket.status !== 'cancelled') {
    throw conflict('只有失败或已取消的工单可以重试')
  }
  const active = await activeRunForTicket(ctx, ticketId)
  if (active) throw conflict('该工单已有排队或执行中的运行')
  const project = await projectForTicket(ctx, ticket)
  ensureProjectActive(project)
  await ensureBudget(ctx, project)
  const kind: RunKind = await retryKind(ctx, ticketId)
  const run = await createRun(ctx, { projectId: ticket.projectId, ticketId, kind, attempt: 2 })
  if (kind === 'plan') {
    await setTicketStatus(ctx, ticket, 'triaged', { updatedAt: ctx.now(), closedAt: null })
  } else {
    await setTicketStatus(ctx, ticket, 'running', { updatedAt: ctx.now(), closedAt: null })
  }
  await audit(ctx, {
    projectId: ticket.projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'ticket.retried',
    target: `ticket:${ticketId}`,
    metadata: { runId: run.id, kind },
  })
  await notifications.executionStarted(ctx, { ...ticket, status: 'running', lastRunId: run.id })
  await wake(ctx, run.id)
  return run
}

export interface PlanResult {
  plan: string
  tokens: number
  cost: number
}

export async function completePlan(ctx: OrchestratorContext, runId: string, result: PlanResult): Promise<void> {
  const run = await finishRun(ctx, runId, {
    status: 'succeeded',
    tokens: result.tokens,
    cost: result.cost,
    result: { plan: result.plan.slice(0, 20_000) },
  })
  if (run.status !== 'succeeded') return
  const ticket = await getTicketById(ctx, run.ticketId)
  const project = await projectForTicket(ctx, ticket)
  const policy = parsePolicy(project.policyJson)
  const planned = await markPlanReady(ctx, ticket.id, result.plan, run.id)
  if (policy.planApproval === 'required') {
    await notifications.approvalNeeded(ctx, planned, result.plan)
    return
  }
  await ctx.db.update(tickets).set({ planApprovedAt: ctx.now() }).where(eq(tickets.id, ticket.id))
  await notifications.planReady(ctx, planned, result.plan, false)
  const approvalRun = await enqueueExecution(ctx, { ...planned, status: 'planned' })
  await audit(ctx, {
    projectId: ticket.projectId,
    action: 'ticket.plan_auto_approved',
    target: `ticket:${ticket.id}`,
    metadata: { runId: approvalRun.id },
  })
}

export interface ExecuteResult {
  summary: string
  prUrl?: string | null
  branch?: string | null
  tokens: number
  cost: number
  logsUrl?: string | null
}

export async function completeExecution(ctx: OrchestratorContext, runId: string, result: ExecuteResult): Promise<void> {
  const run = await finishRun(ctx, runId, {
    status: 'succeeded',
    tokens: result.tokens,
    cost: result.cost,
    result: { summary: result.summary.slice(0, 10_000) },
    branch: result.branch ?? null,
    prUrl: result.prUrl ?? null,
    logsUrl: result.logsUrl ?? null,
  })
  if (run.status !== 'succeeded') return
  const ticket = await getTicketById(ctx, run.ticketId)
  if (ticket.status === 'cancelled') return
  const reviewed = await markWaitingReview(ctx, ticket.id, {
    prUrl: result.prUrl ?? null,
    branch: result.branch ?? null,
    runId: run.id,
  })
  if (result.prUrl) {
    await notifications.prOpened(ctx, reviewed, result.prUrl, result.summary)
  } else {
    await notifications.completedWithoutPr(ctx, reviewed, result.summary)
  }
}

export interface FailureInput {
  reason: string
  tokens?: number
  cost?: number
  timeout?: boolean
}

export async function failRun(ctx: OrchestratorContext, runId: string, input: FailureInput): Promise<void> {
  const [current] = await ctx.db.select().from(runs).where(eq(runs.id, runId))
  if (!current || (current.status !== 'running' && current.status !== 'queued')) return
  const run = await finishRun(ctx, runId, {
    status: input.timeout ? 'timeout' : 'failed',
    tokens: input.tokens ?? 0,
    cost: input.cost ?? 0,
    error: input.reason.slice(0, 4000),
  })
  if (run.status !== 'failed' && run.status !== 'timeout') return
  const ticket = await getTicketById(ctx, run.ticketId)
  if (ticket.status === 'cancelled' || ticket.status === 'done') return
  const project = await projectForTicket(ctx, ticket)
  const policy = parsePolicy(project.policyJson)
  if (policy.retryOnFailure && run.attempt < 2) {
    const retry = await createRun(ctx, {
      projectId: run.projectId,
      ticketId: run.ticketId,
      kind: run.kind,
      attempt: run.attempt + 1,
    })
    await notifications.retrying(ctx, ticket, run.attempt + 1)
    await wake(ctx, retry.id)
    return
  }
  const failed = await markTicketFailed(ctx, ticket.id, input.reason, run.id)
  await notifications.failed(ctx, failed, input.reason)
}

/** §11.3: worker heartbeats are the liveness signal for a claimed run. */
export async function reapStaleRuns(ctx: OrchestratorContext): Promise<number> {
  const stale = await findStaleRuns(ctx, ctx.config.RUN_LEASE_SECONDS)
  if (stale.length === 0) return 0
  for (const run of stale) {
    try {
      await failRun(ctx, run.id, { reason: 'Worker 心跳超时，运行被判定失败', timeout: true })
      await audit(ctx, {
        projectId: run.projectId,
        action: 'run.reaped',
        target: `run:${run.id}`,
        metadata: { workerId: run.workerId },
      })
    } catch (error) {
      ctx.log.error({ err: error, runId: run.id }, 'failed to reap stale run')
    }
  }
  return stale.length
}

export async function markMergedFromWebhook(
  ctx: OrchestratorContext,
  ticketId: string,
  prUrl: string | null,
): Promise<TicketRow | null> {
  const [ticket] = await ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
  if (!ticket) return null
  const done = await markTicketDone(ctx, ticketId, { prUrl })
  await notifications.done(ctx, done)
  return done
}

/** On startup, put orphaned queued/running runs back into a clean terminal state. */
export async function recoverInterruptedRuns(ctx: OrchestratorContext): Promise<number> {
  const running = await findStaleRuns(ctx, 0)
  let count = 0
  for (const run of running) {
    if (run.workerId && run.workerId !== ctx.config.WORKER_ID) continue
    await finishRun(ctx, run.id, { status: 'failed', error: 'worker restarted' })
    const [ticket] = await ctx.db.select().from(tickets).where(eq(tickets.id, run.ticketId))
    if (ticket && ticket.status === 'running') {
      await markTicketFailed(ctx, ticket.id, 'Worker 重启，运行中断', run.id)
    }
    count += 1
  }
  return count
}
