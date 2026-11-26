import { and, count, desc, eq, inArray, like } from 'drizzle-orm'
import type { Deps } from '../services/deps.js'
import { notFound } from '../errors.js'
import { shortId } from '../domain/ids.js'
import {
  agentSessions,
  approvals,
  assignments,
  decisions,
  evaluations,
  mandates,
  messages,
  reports,
  sessionMessages,
  sessionTurns,
  ticketInputs,
  ticketSubscriptions,
  tickets,
  turnEvents,
  type TicketRow,
} from '../db/schema.js'
import type { TicketStatus } from '../domain/status.js'

export interface TicketFilter {
  status?: TicketStatus
  stage?: string
  query?: string
  limit?: number
  offset?: number
  requesterId?: string
}

async function recentTranscript(deps: Deps, sessionId: string, limit = 20): Promise<{ role: string; content: string }[]> {
  const rows = await deps.db
    .select({ role: sessionMessages.role, content: sessionMessages.content })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.createdAt))
    .limit(limit)
  return rows.reverse()
}

export async function listTicketsView(deps: Deps, projectId: string, filter: TicketFilter = {}) {
  const conditions = [eq(tickets.projectId, projectId)]
  if (filter.status) conditions.push(eq(tickets.status, filter.status))
  if (filter.stage) conditions.push(eq(tickets.stage, filter.stage))
  if (filter.requesterId) conditions.push(eq(tickets.requesterId, filter.requesterId))
  if (filter.query) conditions.push(like(tickets.title, `%${filter.query}%`))
  const limit = Math.min(filter.limit ?? 30, 100)
  const [rows, [total]] = await Promise.all([
    deps.db
      .select()
      .from(tickets)
      .where(and(...conditions))
      .orderBy(desc(tickets.createdAt))
      .limit(limit)
      .offset(filter.offset ?? 0),
    deps.db.select({ value: count() }).from(tickets).where(and(...conditions)),
  ])
  return { items: rows, total: Number(total?.value ?? 0), limit, offset: filter.offset ?? 0 }
}

/** Maps a core session turn into the `runs` shape the console expects. */
export function turnToRun(turn: typeof sessionTurns.$inferSelect) {
  return {
    id: turn.id,
    projectId: turn.projectId,
    ticketId: turn.ticketId ?? '',
    kind: turn.kind === 'eval' ? ('plan' as const) : ('execute' as const),
    status: turn.status,
    workerId: null,
    attempt: turn.seq ?? 0,
    turnKind: turn.kind,
    result: turn.result,
    error: turn.error,
    tokens: turn.tokens,
    cost: turn.cost,
    branch: null,
    prUrl: null,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    createdAt: turn.createdAt,
  }
}

export async function ticketDetailView(deps: Deps, projectId: string, ticketId: string) {
  const [ticket] = await deps.db.select().from(tickets).where(and(eq(tickets.projectId, projectId), eq(tickets.id, ticketId)))
  if (!ticket) throw notFound('工单不存在')
  const [turns, approvalRows, messageRows, mandateRow, reportRows, inputRows, session, assignmentRows, subscriptionRows] = await Promise.all([
    deps.db.select().from(sessionTurns).where(eq(sessionTurns.ticketId, ticketId)).orderBy(desc(sessionTurns.createdAt)),
    deps.db.select().from(approvals).where(eq(approvals.ticketId, ticketId)).orderBy(desc(approvals.createdAt)),
    ticket.threadKey
      ? deps.db
          .select()
          .from(messages)
          .where(and(eq(messages.projectId, projectId), eq(messages.threadKey, ticket.threadKey)))
          .orderBy(desc(messages.createdAt))
          .limit(100)
      : Promise.resolve([]),
    deps.db.select().from(mandates).where(eq(mandates.ticketId, ticketId)).limit(1),
    deps.db.select().from(reports).where(eq(reports.ticketId, ticketId)).orderBy(desc(reports.createdAt)),
    deps.db.select().from(ticketInputs).where(eq(ticketInputs.ticketId, ticketId)).orderBy(desc(ticketInputs.createdAt)),
    deps.db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.ticketId, ticketId), eq(agentSessions.role, 'executor')))
      .limit(1),
    deps.db.select().from(assignments).where(eq(assignments.ticketId, ticketId)).orderBy(desc(assignments.createdAt)),
    deps.db.select().from(ticketSubscriptions).where(eq(ticketSubscriptions.ticketId, ticketId)),
  ])
  return {
    ticket,
    runs: turns.map(turnToRun),
    approvals: approvalRows,
    messages: messageRows,
    intake: [],
    ref: `#${shortId(ticket.id)}`,
    mandate: mandateRow[0] ?? null,
    reports: reportRows,
    inputs: inputRows,
    session: session[0] ?? null,
    transcript: session[0] ? await recentTranscript(deps, session[0].id) : [],
    assignments: assignmentRows,
    subscriptions: subscriptionRows,
    turns,
    stage: ticket.stage,
  }
}

export async function runDetailView(deps: Deps, turnId: string) {
  const [turn] = await deps.db.select().from(sessionTurns).where(eq(sessionTurns.id, turnId))
  if (!turn) throw notFound('运行不存在')
  const events = await deps.db.select().from(turnEvents).where(eq(turnEvents.turnId, turnId)).orderBy(turnEvents.id)
  return { run: turnToRun(turn), events, turn }
}

/**
 * Compatibility projection for the legacy `/main-session` console tab:
 * surfaces core Router runs (`evaluations` + `decisions`) when no legacy main
 * session exists.
 */
export async function mainSessionView(deps: Deps, projectId: string) {
  const runs = await deps.db
    .select()
    .from(evaluations)
    .where(eq(evaluations.projectId, projectId))
    .orderBy(desc(evaluations.createdAt))
    .limit(30)
  if (runs.length === 0) return { session: null, transcript: [], turns: [] }

  const runIds = runs.map((run) => run.id)
  const decisionRows = await deps.db
    .select()
    .from(decisions)
    .where(inArray(decisions.runId, runIds))
    .orderBy(desc(decisions.decidedAt))
  const decisionsByRun = new Map<string, typeof decisionRows>()
  for (const row of decisionRows) {
    const list = decisionsByRun.get(row.runId) ?? []
    list.push(row)
    decisionsByRun.set(row.runId, list)
  }

  const latest = runs[0]!
  return {
    session: {
      id: latest.id,
      projectId,
      role: 'main' as const,
      ticketId: null,
      status: latest.status === 'running' ? 'running' : 'idle',
      model: latest.model ?? 'router',
      preset: 'core-router',
      createdAt: runs[runs.length - 1]!.createdAt,
      lastTurnAt: latest.endedAt ?? latest.startedAt ?? latest.createdAt,
    },
    transcript: [...runs].reverse().map((run) => ({
      role: 'assistant',
      content: JSON.stringify(
        (decisionsByRun.get(run.id) ?? []).map((item) => ({
          action: item.action,
          triggerId: item.triggerId,
          reason: item.reason,
          ...(item.title ? { ticket: { title: item.title } } : {}),
        })),
      ),
    })),
    turns: runs.map((run) => ({
      id: run.id,
      projectId: run.projectId,
      ticketId: '',
      kind: 'plan' as const,
      status: run.status === 'decided' ? ('succeeded' as const) : run.status === 'unavailable' ? ('failed' as const) : ('running' as const),
      workerId: null,
      attempt: 1,
      turnKind: 'eval' as const,
      result: { summary: run.summary },
      error: run.reason,
      tokens: (run.promptTokens ?? 0) + (run.outputTokens ?? 0),
      cost: 0,
      branch: null,
      prUrl: null,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      createdAt: run.createdAt,
    })),
  }
}

export async function overviewCounts(deps: Deps, projectId: string) {
  const [ticketCounts, turnCounts, activeTurns] = await Promise.all([
    deps.db.select({ status: tickets.status, value: count() }).from(tickets).where(eq(tickets.projectId, projectId)).groupBy(tickets.status),
    deps.db
      .select({ status: sessionTurns.status, kind: sessionTurns.kind, value: count() })
      .from(sessionTurns)
      .where(eq(sessionTurns.projectId, projectId))
      .groupBy(sessionTurns.status, sessionTurns.kind),
    deps.db
      .select()
      .from(sessionTurns)
      .where(and(eq(sessionTurns.projectId, projectId), inArray(sessionTurns.status, ['queued', 'running'])))
      .orderBy(desc(sessionTurns.createdAt))
      .limit(5),
  ])
  return {
    tickets: Object.fromEntries(ticketCounts.map((row) => [row.status, Number(row.value)])),
    turns: Object.fromEntries(turnCounts.map((row) => [`${row.kind}:${row.status}`, Number(row.value)])),
    activeTurns,
  }
}

export async function findTicketByPr(deps: Deps, prUrl: string): Promise<TicketRow | null> {
  const [row] = await deps.db.select().from(tickets).where(eq(tickets.prUrl, prUrl)).limit(1)
  return row ?? null
}

export async function findTicketByBranch(deps: Deps, branch: string): Promise<TicketRow | null> {
  const [row] = await deps.db.select().from(tickets).where(eq(tickets.branch, branch)).orderBy(desc(tickets.createdAt)).limit(1)
  return row ?? null
}
