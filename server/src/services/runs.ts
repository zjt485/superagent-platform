import { and, asc, count, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import type { Deps } from './deps.js'
import { projects, runEvents, runs, tickets, type RunRow } from '../db/schema.js'
import { conflict, notFound } from '../errors.js'
import { newId } from '../domain/ids.js'
import { ACTIVE_RUN_STATUSES, type RunKind, type RunStatus } from '../domain/status.js'
import { parsePolicy } from '../domain/policy.js'
import { audit } from './audit.js'
import { recordUsage } from './usage.js'

export interface CreateRunInput {
  projectId: string
  ticketId: string
  kind: RunKind
  prompt?: string
  attempt?: number
}

export async function activeRunForTicket(deps: Deps, ticketId: string): Promise<RunRow | null> {
  const [row] = await deps.db
    .select()
    .from(runs)
    .where(and(eq(runs.ticketId, ticketId), inArray(runs.status, [...ACTIVE_RUN_STATUSES])))
  return row ?? null
}

export async function createRun(deps: Deps, input: CreateRunInput): Promise<RunRow> {
  const active = await activeRunForTicket(deps, input.ticketId)
  if (active) throw conflict('该工单已有排队或执行中的运行')
  const [ticket] = await deps.db.select().from(tickets).where(eq(tickets.id, input.ticketId))
  if (!ticket) throw notFound('工单不存在')
  const runId = newId()
  try {
    const [row] = await deps.db
      .insert(runs)
      .values({
        id: runId,
        projectId: input.projectId,
        ticketId: input.ticketId,
        kind: input.kind,
        status: 'queued',
        attempt: input.attempt ?? 1,
        prompt: input.prompt ?? null,
        createdAt: deps.now(),
      })
      .returning()
    if (!row) throw new Error('failed to insert run')
    await audit(deps, {
      projectId: input.projectId,
      action: 'run.queued',
      target: `run:${row.id}`,
      metadata: { ticketId: input.ticketId, kind: input.kind, attempt: row.attempt },
    })
    return row
  } catch (error) {
    if (error instanceof Error && /one_active_per_ticket/.test(error.message)) {
      throw conflict('该工单已有排队或执行中的运行')
    }
    throw error
  }
}

/**
 * Atomically claims one queued run for this worker while respecting each
 * project's maxConcurrentRuns policy and project status. The guarded UPDATE
 * keeps two workers from claiming the same row.
 */
export async function claimNextRun(deps: Deps, workerId: string): Promise<RunRow | null> {
  const runningCounts = await deps.db
    .select({ projectId: runs.projectId, value: count() })
    .from(runs)
    .where(eq(runs.status, 'running'))
    .groupBy(runs.projectId)
  const runningByProject = new Map(runningCounts.map((row) => [row.projectId, Number(row.value)]))

  const candidates = await deps.db
    .select()
    .from(runs)
    .where(eq(runs.status, 'queued'))
    .orderBy(asc(runs.createdAt))
    .limit(25)
  if (candidates.length === 0) return null

  const projectIds = [...new Set(candidates.map((row) => row.projectId))]
  const projectRows = await deps.db.select().from(projects).where(inArray(projects.id, projectIds))
  const projectById = new Map(projectRows.map((row) => [row.id, row]))

  for (const candidate of candidates) {
    const project = projectById.get(candidate.projectId)
    if (!project || project.status !== 'active') continue
    const policy = parsePolicy(project.policyJson)
    if ((runningByProject.get(candidate.projectId) ?? 0) >= policy.maxConcurrentRuns) continue

    // A ticket cancelled while queued must not execute.
    const [ticket] = await deps.db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, candidate.ticketId))
    if (!ticket || ticket.status === 'cancelled' || ticket.status === 'done') {
      await deps.db
        .update(runs)
        .set({ status: 'cancelled', endedAt: deps.now(), error: 'ticket is no longer runnable' })
        .where(and(eq(runs.id, candidate.id), eq(runs.status, 'queued')))
      continue
    }

    const [claimed] = await deps.db
      .update(runs)
      .set({ status: 'running', workerId, startedAt: deps.now(), heartbeatAt: deps.now() })
      .where(and(eq(runs.id, candidate.id), eq(runs.status, 'queued')))
      .returning()
    if (claimed) {
      runningByProject.set(claimed.projectId, (runningByProject.get(claimed.projectId) ?? 0) + 1)
      await audit(deps, { projectId: claimed.projectId, action: 'run.started', target: `run:${claimed.id}`, metadata: { workerId } })
      return claimed
    }
  }
  return null
}

/** Claims one specific queued run (Redis/BullMQ path) after the same policy checks. */
export async function claimRunById(deps: Deps, runId: string, workerId: string): Promise<RunRow | null> {
  const [candidate] = await deps.db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.status, 'queued')))
  if (!candidate) return null
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, candidate.projectId))
  if (!project || project.status !== 'active') return null
  const policy = parsePolicy(project.policyJson)
  const [running] = await deps.db
    .select({ value: count() })
    .from(runs)
    .where(and(eq(runs.projectId, candidate.projectId), eq(runs.status, 'running')))
  if (Number(running?.value ?? 0) >= policy.maxConcurrentRuns) return null
  const [ticket] = await deps.db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, candidate.ticketId))
  if (!ticket || ticket.status === 'cancelled' || ticket.status === 'done') return null

  const [claimed] = await deps.db
    .update(runs)
    .set({ status: 'running', workerId, startedAt: deps.now(), heartbeatAt: deps.now() })
    .where(and(eq(runs.id, runId), eq(runs.status, 'queued')))
    .returning()
  if (claimed) {
    await audit(deps, { projectId: claimed.projectId, action: 'run.started', target: `run:${claimed.id}`, metadata: { workerId } })
  }
  return claimed ?? null
}

export interface FinishRunInput {
  status: Exclude<RunStatus, 'queued' | 'running'>
  tokens?: number
  cost?: number
  result?: Record<string, unknown>
  error?: string | null
  branch?: string | null
  prUrl?: string | null
  logsUrl?: string | null
}

/** Terminal transition; records usage exactly once per run. */
export async function finishRun(deps: Deps, runId: string, input: FinishRunInput): Promise<RunRow> {
  const [run] = await deps.db.select().from(runs).where(eq(runs.id, runId))
  if (!run) throw notFound('运行不存在')
  if (run.status !== 'running' && run.status !== 'queued') return run
  const [row] = await deps.db
    .update(runs)
    .set({
      status: input.status,
      endedAt: deps.now(),
      tokens: Math.max(0, Math.round(input.tokens ?? 0)),
      cost: Math.max(0, input.cost ?? 0),
      result: input.result ?? null,
      error: input.error ?? null,
      branch: input.branch ?? run.branch,
      prUrl: input.prUrl ?? run.prUrl,
      logsUrl: input.logsUrl ?? run.logsUrl,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, run.status)))
    .returning()
  if (!row) return run
  const finished = row
  await recordUsage(deps, run.projectId, finished.tokens, finished.cost)
  await audit(deps, {
    projectId: run.projectId,
    action: `run.${input.status}`,
    target: `run:${runId}`,
    metadata: {
      ticketId: run.ticketId,
      kind: run.kind,
      tokens: finished.tokens,
      cost: finished.cost,
      ...(input.error ? { error: input.error.slice(0, 300) } : {}),
    },
  })
  return finished
}

export async function recordRunEvent(
  deps: Deps,
  runId: string,
  event: { type: string; message?: string | null; payload?: unknown },
): Promise<void> {
  const [run] = await deps.db.select({ projectId: runs.projectId, status: runs.status }).from(runs).where(eq(runs.id, runId))
  if (!run) throw notFound('运行不存在')
  await deps.db.insert(runEvents).values({
    projectId: run.projectId,
    runId,
    type: event.type.slice(0, 80),
    message: event.message?.slice(0, 4000) ?? null,
    payload: (event.payload ?? null) as Record<string, unknown> | null,
    createdAt: deps.now(),
  })
  if (run.status === 'running') {
    await deps.db.update(runs).set({ heartbeatAt: deps.now() }).where(eq(runs.id, runId))
  }
}

export async function listRunEvents(deps: Deps, runId: string, limit = 200) {
  return deps.db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.id)).limit(Math.min(limit, 1000))
}

export async function listRuns(deps: Deps, ticketId: string) {
  return deps.db.select().from(runs).where(eq(runs.ticketId, ticketId)).orderBy(desc(runs.createdAt))
}

export async function getRun(deps: Deps, runId: string) {
  const [row] = await deps.db.select().from(runs).where(eq(runs.id, runId))
  if (!row) throw notFound('运行不存在')
  return row
}

export async function requestRunCancel(deps: Deps, runId: string): Promise<void> {
  await deps.db
    .update(runs)
    .set({ cancelRequestedAt: deps.now() })
    .where(and(eq(runs.id, runId), inArray(runs.status, [...ACTIVE_RUN_STATUSES])))
}

export async function isRunCancelled(deps: Deps, runId: string): Promise<boolean> {
  const [row] = await deps.db.select({ cancelRequestedAt: runs.cancelRequestedAt, status: runs.status }).from(runs).where(eq(runs.id, runId))
  return row?.status === 'cancelled' || Boolean(row?.cancelRequestedAt)
}

export async function cancelQueuedRuns(deps: Deps, ticketId: string): Promise<void> {
  await deps.db
    .update(runs)
    .set({ status: 'cancelled', endedAt: deps.now(), error: 'ticket cancelled' })
    .where(and(eq(runs.ticketId, ticketId), eq(runs.status, 'queued')))
}

export async function heartbeatRun(deps: Deps, runId: string): Promise<void> {
  await deps.db.update(runs).set({ heartbeatAt: deps.now() }).where(and(eq(runs.id, runId), eq(runs.status, 'running')))
}

/** §11.3: a run whose worker stopped heartbeating becomes `timeout`. */
export async function findStaleRuns(deps: Deps, leaseSeconds: number): Promise<RunRow[]> {
  const cutoff = new Date(deps.now().getTime() - leaseSeconds * 1000)
  return deps.db
    .select()
    .from(runs)
    .where(and(eq(runs.status, 'running'), lt(sql`coalesce(${runs.heartbeatAt}, ${runs.startedAt}, ${runs.createdAt})`, cutoff)))
}
