import { and, count, desc, eq, inArray, like } from 'drizzle-orm'
import type { Deps } from './deps.js'
import { approvals, intakeEvents, messages, runs, tickets, type TicketRow } from '../db/schema.js'
import { conflict, notFound } from '../errors.js'
import { newId, shortId } from '../domain/ids.js'
import {
  ACTIVE_TICKET_STATUSES,
  canTransitionTicket,
  TERMINAL_TICKET_STATUSES,
  type RunKind,
  type TicketPriority,
  type TicketStatus,
} from '../domain/status.js'
import { audit } from './audit.js'
import { requireProjectAccess } from './access.js'
import { cancelQueuedRuns, requestRunCancel } from './runs.js'

export interface CreateTicketInput {
  projectId: string
  channelId?: string | null
  threadKey?: string | null
  requesterId?: string | null
  requesterName?: string | null
  title: string
  body: string
  priority?: TicketPriority
}

export const ticketRef = (ticket: { id: string }): string => `#${shortId(ticket.id)}`

export async function createTicket(deps: Deps, input: CreateTicketInput): Promise<TicketRow> {
  const title = input.title.trim()
  const body = input.body.trim()
  if (!title) throw conflict('工单标题不能为空')
  const [row] = await deps.db
    .insert(tickets)
    .values({
      id: newId(),
      projectId: input.projectId,
      channelId: input.channelId ?? null,
      threadKey: input.threadKey ?? null,
      requesterId: input.requesterId ?? null,
      requesterName: input.requesterName ?? null,
      title: title.slice(0, 200),
      body: body.slice(0, 20_000),
      status: 'new',
      priority: input.priority ?? 'normal',
      createdAt: deps.now(),
      updatedAt: deps.now(),
    })
    .returning()
  if (!row) throw new Error('failed to create ticket')
  await audit(deps, {
    projectId: input.projectId,
    actorId: input.requesterId ?? null,
    actorLabel: input.requesterName ?? null,
    action: 'ticket.created',
    target: `ticket:${row.id}`,
    metadata: { title: row.title, channelId: input.channelId ?? null, threadKey: input.threadKey ?? null },
  })
  return row
}

export async function getTicketRow(deps: Deps, projectId: string, ticketId: string): Promise<TicketRow> {
  const [row] = await deps.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), eq(tickets.id, ticketId)))
  if (!row) throw notFound('工单不存在')
  return row
}

export async function getTicketById(deps: Deps, ticketId: string): Promise<TicketRow> {
  const [row] = await deps.db.select().from(tickets).where(eq(tickets.id, ticketId))
  if (!row) throw notFound('工单不存在')
  return row
}

/** Most recent ticket on a thread, including ended ones (reopen semantics). */
export async function ticketForThread(
  deps: Deps,
  projectId: string,
  channelId: string,
  threadKey: string,
): Promise<TicketRow | null> {
  const [row] = await deps.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), eq(tickets.channelId, channelId), eq(tickets.threadKey, threadKey)))
    .orderBy(desc(tickets.createdAt))
    .limit(1)
  return row ?? null
}

export async function latestActiveTicketInChannel(deps: Deps, projectId: string, channelId: string): Promise<TicketRow | null> {
  const [row] = await deps.db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.projectId, projectId),
        eq(tickets.channelId, channelId),
        inArray(tickets.status, [...ACTIVE_TICKET_STATUSES]),
      ),
    )
    .orderBy(desc(tickets.createdAt))
    .limit(1)
  return row ?? null
}

/** Resolves `#abc123`, a UUID prefix or the latest ticket in a thread. */
export async function resolveTicket(
  deps: Deps,
  projectId: string,
  input: { ref?: string; channelId?: string | null; threadKey?: string | null },
): Promise<TicketRow> {
  if (input.ref) {
    const ref = input.ref.trim().replace(/^#/, '').toLowerCase()
    if (!ref) throw conflict('工单标识为空')
    const candidates = await deps.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId))
      .orderBy(desc(tickets.createdAt))
      .limit(300)
    const match = candidates.find((row) => row.id === ref || row.id.startsWith(ref) || shortId(row.id).startsWith(ref))
    if (match) return match
    throw notFound(`找不到工单 ${input.ref}`)
  }
  if (input.channelId && input.threadKey) {
    const byThread = await ticketForThread(deps, projectId, input.channelId, input.threadKey)
    if (byThread) return byThread
  }
  if (input.channelId) {
    const latest = await latestActiveTicketInChannel(deps, projectId, input.channelId)
    if (latest) return latest
  }
  throw notFound('当前会话没有可操作的工单，请使用 `/cancel #工单号` 指定')
}

export async function setTicketStatus(
  deps: Deps,
  ticket: TicketRow,
  to: TicketStatus,
  patch: Partial<typeof tickets.$inferInsert> = {},
): Promise<TicketRow> {
  if (ticket.status === to) return ticket
  if (!canTransitionTicket(ticket.status, to)) {
    throw conflict(`工单状态不能从 ${ticket.status} 变为 ${to}`)
  }
  const [row] = await deps.db
    .update(tickets)
    .set({
      ...patch,
      status: to,
      updatedAt: deps.now(),
      ...(TERMINAL_TICKET_STATUSES.includes(to) ? { closedAt: deps.now() } : {}),
    })
    .where(and(eq(tickets.id, ticket.id), eq(tickets.status, ticket.status)))
    .returning()
  if (!row) {
    // Someone else moved the ticket concurrently; return the fresh row.
    return getTicketById(deps, ticket.id)
  }
  if (ticket.status !== to) {
    await audit(deps, {
      projectId: ticket.projectId,
      action: 'ticket.status_changed',
      target: `ticket:${ticket.id}`,
      metadata: { from: ticket.status, to },
    })
  }
  return row
}

export async function markPlanReady(
  deps: Deps,
  ticketId: string,
  plan: string,
  runId?: string,
): Promise<TicketRow> {
  const ticket = await getTicketById(deps, ticketId)
  return setTicketStatus(deps, ticket, 'planned', {
    plan: plan.slice(0, 20_000),
    ...(runId ? { lastRunId: runId } : {}),
    updatedAt: deps.now(),
  })
}

export async function markWaitingReview(
  deps: Deps,
  ticketId: string,
  input: { prUrl?: string | null; branch?: string | null; runId?: string | null },
): Promise<TicketRow> {
  const ticket = await getTicketById(deps, ticketId)
  return setTicketStatus(deps, ticket, 'waiting_review', {
    ...(input.prUrl ? { prUrl: input.prUrl } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.runId ? { lastRunId: input.runId } : {}),
    updatedAt: deps.now(),
  })
}

export async function markTicketFailed(deps: Deps, ticketId: string, reason: string, runId?: string): Promise<TicketRow> {
  const ticket = await getTicketById(deps, ticketId)
  if (TERMINAL_TICKET_STATUSES.includes(ticket.status)) return ticket
  return setTicketStatus(deps, ticket, 'failed', {
    ...(runId ? { lastRunId: runId } : {}),
    updatedAt: deps.now(),
  }).then(async (row) => {
    await audit(deps, {
      projectId: ticket.projectId,
      action: 'ticket.failed',
      target: `ticket:${ticketId}`,
      metadata: { reason: reason.slice(0, 500) },
    })
    return row
  })
}

export async function markTicketDone(deps: Deps, ticketId: string, input: { prUrl?: string | null } = {}): Promise<TicketRow> {
  const ticket = await getTicketById(deps, ticketId)
  if (ticket.status === 'done') return ticket
  if (!canTransitionTicket(ticket.status, 'done')) {
    // A merged PR is the truth: allow any non-terminal ticket to close.
    const [row] = await deps.db
      .update(tickets)
      .set({ status: 'done', prUrl: input.prUrl ?? ticket.prUrl, closedAt: deps.now(), updatedAt: deps.now() })
      .where(eq(tickets.id, ticketId))
      .returning()
    if (!row) throw notFound('工单不存在')
    return row
  }
  return setTicketStatus(deps, ticket, 'done', {
    ...(input.prUrl ? { prUrl: input.prUrl } : {}),
    updatedAt: deps.now(),
  })
}

export async function markTicketCancelled(deps: Deps, ticket: TicketRow, actor?: { id: string; name: string }): Promise<TicketRow> {
  if (ticket.status === 'cancelled') return ticket
  if (ticket.status === 'done') throw conflict('已完成的工单不能取消')
  const [row] = await deps.db
    .update(tickets)
    .set({ status: 'cancelled', closedAt: deps.now(), updatedAt: deps.now() })
    .where(eq(tickets.id, ticket.id))
    .returning()
  await cancelQueuedRuns(deps, ticket.id)
  const activeRuns = await deps.db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.ticketId, ticket.id), eq(runs.status, 'running')))
  for (const run of activeRuns) await requestRunCancel(deps, run.id)
  await audit(deps, {
    projectId: ticket.projectId,
    actorId: actor?.id ?? null,
    actorLabel: actor?.name ?? null,
    action: 'ticket.cancelled',
    target: `ticket:${ticket.id}`,
    metadata: { from: ticket.status },
  })
  if (!row) throw notFound('工单不存在')
  return row
}

export async function approveTicketPlan(
  deps: Deps,
  projectId: string,
  ticketId: string,
  actor: { id: string; name: string; isAdmin: boolean },
  comment?: string,
): Promise<TicketRow> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'maintainer')
  const ticket = await getTicketRow(deps, projectId, ticketId)
  if (ticket.status !== 'planned') throw conflict('只有等待审批的计划可以批准')
  await deps.db.insert(approvals).values({
    id: newId(),
    projectId,
    ticketId,
    kind: 'plan',
    actorId: actor.id,
    decision: 'approved',
    comment: comment?.slice(0, 2000) ?? null,
    createdAt: deps.now(),
  })
  const [row] = await deps.db
    .update(tickets)
    .set({ planApprovedAt: deps.now(), updatedAt: deps.now() })
    .where(eq(tickets.id, ticketId))
    .returning()
  await audit(deps, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'ticket.plan_approved',
    target: `ticket:${ticketId}`,
    metadata: { comment: comment?.slice(0, 300) ?? null },
  })
  if (!row) throw notFound('工单不存在')
  return row
}

/** Which kind of run a retry should create. */
export async function retryKind(deps: Deps, ticketId: string): Promise<RunKind> {
  const [run] = await deps.db.select({ kind: runs.kind }).from(runs).where(eq(runs.ticketId, ticketId)).orderBy(desc(runs.createdAt)).limit(1)
  return run?.kind ?? 'execute'
}

export interface TicketListFilter {
  status?: TicketStatus
  query?: string
  limit?: number
  offset?: number
  requesterId?: string
}

export async function listTickets(deps: Deps, projectId: string, filter: TicketListFilter = {}) {
  const where = [eq(tickets.projectId, projectId)]
  if (filter.status) where.push(eq(tickets.status, filter.status))
  if (filter.requesterId) where.push(eq(tickets.requesterId, filter.requesterId))
  if (filter.query) where.push(like(tickets.title, `%${filter.query}%`))
  const limit = Math.min(filter.limit ?? 30, 100)
  const rows = await deps.db
    .select()
    .from(tickets)
    .where(and(...where))
    .orderBy(desc(tickets.createdAt))
    .limit(limit)
    .offset(filter.offset ?? 0)
  const [total] = await deps.db.select({ value: count() }).from(tickets).where(and(...where))
  return { items: rows, total: Number(total?.value ?? 0), limit, offset: filter.offset ?? 0 }
}

export async function ticketDetail(deps: Deps, projectId: string, ticketId: string) {
  const ticket = await getTicketRow(deps, projectId, ticketId)
  const runRows = await deps.db.select().from(runs).where(eq(runs.ticketId, ticketId)).orderBy(desc(runs.createdAt))
  const approvalRows = await deps.db.select().from(approvals).where(eq(approvals.ticketId, ticketId)).orderBy(desc(approvals.createdAt))
  const messageRows = await deps.db
    .select()
    .from(messages)
    .where(and(eq(messages.projectId, projectId), eq(messages.threadKey, ticket.threadKey ?? '')))
    .orderBy(desc(messages.createdAt))
    .limit(100)
  const intakeRows = await deps.db
    .select()
    .from(intakeEvents)
    .where(and(eq(intakeEvents.projectId, projectId), eq(intakeEvents.ticketId, ticketId)))
    .orderBy(desc(intakeEvents.createdAt))
    .limit(20)
  return {
    ticket,
    runs: runRows,
    approvals: approvalRows,
    messages: messageRows,
    intake: intakeRows,
    ref: ticketRef(ticket),
  }
}
