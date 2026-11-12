import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Deps } from '../services/deps.js'
import { audit } from '../services/audit.js'
import { recordUsage } from '../services/usage.js'
import { isUniqueViolation } from '../db/errors.js'
import {
  agentSessions,
  assignments,
  projects,
  sessionMessages,
  sessionTurns,
  tickets,
  turnEvents,
  type ProjectRow,
} from '../db/schema.js'
import { newId } from '../domain/ids.js'
import { parsePolicy } from '../domain/policy.js'
import type { TurnKind, TurnStatus } from '../domain/status.js'

export type AgentSessionRow = typeof agentSessions.$inferSelect
export type TurnRow = typeof sessionTurns.$inferSelect

export async function ensureMainSession(deps: Deps, project: ProjectRow): Promise<AgentSessionRow> {
  const [existing] = await deps.db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.projectId, project.id), eq(agentSessions.role, 'main')))
  if (existing) return existing
  const id = newId()
  try {
    await deps.db.insert(agentSessions).values({
      id,
      projectId: project.id,
      role: 'main',
      status: 'idle',
      model: project.modelConfig?.model ?? null,
      preset: 'superagent-main',
      createdAt: deps.now(),
      updatedAt: deps.now(),
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }
  const [row] = await deps.db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.projectId, project.id), eq(agentSessions.role, 'main')))
  if (!row) throw new Error('failed to create Main Session')
  return row
}

export async function ensureExecutorSession(deps: Deps, project: ProjectRow, ticketId: string): Promise<AgentSessionRow> {
  const [existing] = await deps.db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.ticketId, ticketId), eq(agentSessions.role, 'executor')))
  if (existing) return existing
  const id = newId()
  try {
    await deps.db.insert(agentSessions).values({
      id,
      projectId: project.id,
      role: 'executor',
      ticketId,
      status: 'idle',
      model: project.modelConfig?.model ?? null,
      preset: 'superagent-executor',
      createdAt: deps.now(),
      updatedAt: deps.now(),
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }
  const [row] = await deps.db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.ticketId, ticketId), eq(agentSessions.role, 'executor')))
  if (!row) throw new Error('failed to create Executor Session')
  return row
}

export async function appendSessionMessage(
  deps: Deps,
  session: AgentSessionRow,
  role: 'user' | 'assistant' | 'system',
  content: string,
  turnId?: string | null,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await deps.db.insert(sessionMessages).values({
    id: newId(),
    projectId: session.projectId,
    sessionId: session.id,
    turnId: turnId ?? null,
    role,
    content: content.slice(0, 20_000),
    metadata: metadata ?? null,
    createdAt: deps.now(),
  })
}

export async function recentTranscript(deps: Deps, sessionId: string, limit = 12): Promise<{ role: string; content: string }[]> {
  const rows = await deps.db
    .select({ role: sessionMessages.role, content: sessionMessages.content })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.createdAt))
    .limit(limit)
  return rows.reverse()
}

export interface CreateTurnInput {
  session: AgentSessionRow
  kind: TurnKind
  ticketId?: string | null
  evaluationId?: string | null
  assignmentId?: string | null
  input?: unknown
}

export async function createTurn(deps: Deps, input: CreateTurnInput): Promise<TurnRow> {
  const id = newId()
  const [row] = await deps.db
    .insert(sessionTurns)
    .values({
      id,
      projectId: input.session.projectId,
      sessionId: input.session.id,
      ticketId: input.ticketId ?? null,
      evaluationId: input.evaluationId ?? null,
      assignmentId: input.assignmentId ?? null,
      kind: input.kind,
      status: 'queued',
      input: input.input ?? null,
      createdAt: deps.now(),
    })
    .returning()
  if (!row) throw new Error('failed to create session turn')
  return row
}

export async function activeExecutorTurn(deps: Deps, ticketId: string): Promise<TurnRow | null> {
  const [row] = await deps.db
    .select()
    .from(sessionTurns)
    .where(and(eq(sessionTurns.ticketId, ticketId), inArray(sessionTurns.status, ['queued', 'running'])))
  return row ?? null
}

export async function runningTurnForSession(deps: Deps, sessionId: string): Promise<TurnRow | null> {
  const [row] = await deps.db
    .select()
    .from(sessionTurns)
    .where(and(eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.status, 'running')))
  return row ?? null
}

/**
 * Claims one queued turn. Main-Session evals are serialized per session but not
 * counted against project worker concurrency; Executor turns respect
 * `maxConcurrentRuns` just like the old worker pool.
 */
export async function claimNextTurn(deps: Deps, workerId: string): Promise<TurnRow | null> {
  const candidates = await deps.db
    .select()
    .from(sessionTurns)
    .where(eq(sessionTurns.status, 'queued'))
    .orderBy(asc(sessionTurns.createdAt))
    .limit(30)
  if (candidates.length === 0) return null

  const projectIds = [...new Set(candidates.map((row) => row.projectId))]
  const projectRows = await deps.db.select().from(projects).where(inArray(projects.id, projectIds))
  const projectById = new Map(projectRows.map((row) => [row.id, row]))
  const runningExecutor = await deps.db
    .select({ projectId: sessionTurns.projectId, value: count() })
    .from(sessionTurns)
    .where(and(eq(sessionTurns.status, 'running'), eq(sessionTurns.kind, 'execute')))
    .groupBy(sessionTurns.projectId)
  const runningByProject = new Map(runningExecutor.map((row) => [row.projectId, Number(row.value)]))

  for (const candidate of candidates) {
    const project = projectById.get(candidate.projectId)
    if (!project || project.status !== 'active') continue
    const running = await runningTurnForSession(deps, candidate.sessionId)
    if (running) continue

    if (candidate.kind === 'execute') {
      if (!candidate.ticketId) continue
      const [ticket] = await deps.db.select({ status: tickets.status, stage: tickets.stage }).from(tickets).where(eq(tickets.id, candidate.ticketId))
      if (!ticket || ticket.stage === 'done' || ticket.stage === 'cancelled') continue
      const policy = parsePolicy(project.policyJson)
      if ((runningByProject.get(candidate.projectId) ?? 0) >= policy.maxConcurrentRuns) continue
    }

    const [claimed] = await deps.db
      .update(sessionTurns)
      .set({ status: 'running', startedAt: deps.now(), heartbeatAt: deps.now() })
      .where(and(eq(sessionTurns.id, candidate.id), eq(sessionTurns.status, 'queued')))
      .returning()
    if (!claimed) continue

    await deps.db
      .update(agentSessions)
      .set({ status: 'running', lastTurnAt: deps.now(), updatedAt: deps.now() })
      .where(eq(agentSessions.id, claimed.sessionId))
    if (claimed.assignmentId) {
      await deps.db
        .update(assignments)
        .set({ status: 'running', startedAt: deps.now() })
        .where(and(eq(assignments.id, claimed.assignmentId), eq(assignments.status, 'pending')))
    }
    if (claimed.kind === 'execute') {
      runningByProject.set(claimed.projectId, (runningByProject.get(claimed.projectId) ?? 0) + 1)
    }
    await audit(deps, {
      projectId: claimed.projectId,
      action: 'turn.started',
      target: `turn:${claimed.id}`,
      metadata: { workerId, kind: claimed.kind, ticketId: claimed.ticketId },
    })
    return claimed
  }
  return null
}

/** Claims one specific queued turn (Redis/BullMQ path) with the same policy checks. */
export async function claimTurnById(deps: Deps, turnId: string, workerId: string): Promise<TurnRow | null> {
  const [candidate] = await deps.db.select().from(sessionTurns).where(and(eq(sessionTurns.id, turnId), eq(sessionTurns.status, 'queued')))
  if (!candidate) return null
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, candidate.projectId))
  if (!project || project.status !== 'active') return null
  const running = await runningTurnForSession(deps, candidate.sessionId)
  if (running) return null
  if (candidate.kind === 'execute') {
    if (!candidate.ticketId) return null
    const [ticket] = await deps.db.select({ stage: tickets.stage }).from(tickets).where(eq(tickets.id, candidate.ticketId))
    if (!ticket || ticket.stage === 'done' || ticket.stage === 'cancelled') return null
    const policy = parsePolicy(project.policyJson)
    const [runningCount] = await deps.db
      .select({ value: count() })
      .from(sessionTurns)
      .where(and(eq(sessionTurns.projectId, candidate.projectId), eq(sessionTurns.status, 'running'), eq(sessionTurns.kind, 'execute')))
    if (Number(runningCount?.value ?? 0) >= policy.maxConcurrentRuns) return null
  }
  const [claimed] = await deps.db
    .update(sessionTurns)
    .set({ status: 'running', startedAt: deps.now(), heartbeatAt: deps.now() })
    .where(and(eq(sessionTurns.id, candidate.id), eq(sessionTurns.status, 'queued')))
    .returning()
  if (!claimed) return null
  await deps.db.update(agentSessions).set({ status: 'running', lastTurnAt: deps.now(), updatedAt: deps.now() }).where(eq(agentSessions.id, claimed.sessionId))
  if (claimed.assignmentId) {
    await deps.db
      .update(assignments)
      .set({ status: 'running', startedAt: deps.now() })
      .where(and(eq(assignments.id, claimed.assignmentId), eq(assignments.status, 'pending')))
  }
  await audit(deps, { projectId: claimed.projectId, action: 'turn.started', target: `turn:${claimed.id}`, metadata: { workerId, kind: claimed.kind, ticketId: claimed.ticketId } })
  return claimed
}

export interface FinishTurnInput {
  status: Exclude<TurnStatus, 'queued' | 'running'>
  result?: unknown
  error?: string | null
  tokens?: number
  cost?: number
}

export async function finishTurn(deps: Deps, turn: TurnRow, input: FinishTurnInput): Promise<TurnRow> {
  const [row] = await deps.db
    .update(sessionTurns)
    .set({
      status: input.status,
      result: input.result ?? null,
      error: input.error ?? null,
      tokens: Math.max(0, Math.round(input.tokens ?? 0)),
      cost: Math.max(0, input.cost ?? 0),
      endedAt: deps.now(),
    })
    .where(and(eq(sessionTurns.id, turn.id), eq(sessionTurns.status, 'running')))
    .returning()
  const finished = row ?? turn
  await deps.db
    .update(agentSessions)
    .set({ status: input.status === 'succeeded' ? 'idle' : 'error', updatedAt: deps.now() })
    .where(eq(agentSessions.id, turn.sessionId))
  if (turn.assignmentId) {
    await deps.db
      .update(assignments)
      .set({ status: 'ended', endedAt: deps.now() })
      .where(and(eq(assignments.id, turn.assignmentId), inArray(assignments.status, ['pending', 'running'])))
  }
  if (turn.kind === 'execute') {
    await recordUsage(deps, turn.projectId, finished.tokens, finished.cost)
  }
  await audit(deps, {
    projectId: turn.projectId,
    action: `turn.${input.status}`,
    target: `turn:${turn.id}`,
    metadata: {
      kind: turn.kind,
      ticketId: turn.ticketId,
      tokens: finished.tokens,
      ...(input.error ? { error: input.error.slice(0, 300) } : {}),
    },
  })
  return finished
}

export async function recordTurnEvent(
  deps: Deps,
  turn: TurnRow,
  event: { type: string; message?: string | null; payload?: unknown },
): Promise<void> {
  await deps.db.insert(turnEvents).values({
    projectId: turn.projectId,
    turnId: turn.id,
    type: event.type.slice(0, 80),
    message: event.message?.slice(0, 4000) ?? null,
    payload: (event.payload ?? null) as Record<string, unknown> | null,
    createdAt: deps.now(),
  })
}

export async function listTurnEvents(deps: Deps, turnId: string, limit = 200) {
  return deps.db
    .select()
    .from(turnEvents)
    .where(eq(turnEvents.turnId, turnId))
    .orderBy(asc(turnEvents.id))
    .limit(Math.min(limit, 1000))
}

export async function findTurn(deps: Deps, turnId: string): Promise<TurnRow> {
  const [row] = await deps.db.select().from(sessionTurns).where(eq(sessionTurns.id, turnId))
  if (!row) throw new Error('turn not found')
  return row
}

export async function cancelQueuedTurns(deps: Deps, ticketId: string): Promise<void> {
  await deps.db
    .update(sessionTurns)
    .set({ status: 'cancelled', endedAt: deps.now(), error: 'ticket stopped' })
    .where(and(eq(sessionTurns.ticketId, ticketId), eq(sessionTurns.status, 'queued')))
  await deps.db
    .update(assignments)
    .set({ status: 'ended', endedAt: deps.now() })
    .where(and(eq(assignments.ticketId, ticketId), eq(assignments.status, 'pending')))
}

/** Marks turns whose worker stopped heartbeating as failed. */
export async function findStaleTurns(deps: Deps, leaseSeconds: number): Promise<TurnRow[]> {
  const cutoff = new Date(deps.now().getTime() - leaseSeconds * 1000)
  return deps.db
    .select()
    .from(sessionTurns)
    .where(
      and(
        eq(sessionTurns.status, 'running'),
        sql`coalesce(${sessionTurns.heartbeatAt}, ${sessionTurns.startedAt}, ${sessionTurns.createdAt}) < ${cutoff}`,
      ),
    )
}
