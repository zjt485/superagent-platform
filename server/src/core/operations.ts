import { and, eq, inArray } from 'drizzle-orm'

import type { Deps } from '../services/deps.js'
import type { QueuePort } from '../domain/queue.js'
import { newId } from '../domain/ids.js'
import { parsePolicy } from '../domain/policy.js'
import { audit } from '../services/audit.js'
import { notifications } from '../services/notifications.js'
import { tokensUsedToday } from '../services/usage.js'
import { conflict, notFound } from '../errors.js'
import {
  approvals,
  mandates,
  projects,
  sessionTurns,
  ticketSubscriptions,
  tickets,
  turnEvents,
  type ChannelRow,
  type ProjectRow,
  type TicketRow,
  type TurnRow,
} from '../db/schema.js'
import { branchName, ticketShortName } from './domain/ids.js'
import { nextStage } from './domain/stage.js'
import type { InputKind, TicketStage } from './domain/types.js'
import { policyVersion } from './policy.js'
import { insertTicketInput } from './store/inputs.js'
import { ensureExecutorSession } from './store/sessions.js'
import { insertTicket, setTicketStage } from './store/tickets.js'
import { insertTurn, nextTurnSeq } from './store/turns.js'

export interface CoreContext extends Deps {
  queue: QueuePort
}

export interface CreateConsoleTicketInput {
  project: ProjectRow
  channel: ChannelRow | null
  actor: { id: string; name: string }
  title: string
  body: string
  scope: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
}

/** Create a ticket directly from the Web console and queue its first executor turn. */
export async function createConsoleTicket(
  ctx: CoreContext,
  input: CreateConsoleTicketInput,
): Promise<{ ticket: TicketRow; turnId: string | null }> {
  const at = ctx.now()
  const policy = parsePolicy(input.project.policyJson)
  const pVersion = policyVersion(policy)
  const shortName = ticketShortName()
  const ticketId = newId()
  const threadKey = `console:${ticketId}`

  const ticket = await insertTicket(ctx.db, {
    id: ticketId,
    projectId: input.project.id,
    channelId: input.channel?.id ?? null,
    threadKey,
    requesterId: input.actor.id,
    requesterName: input.actor.name,
    title: input.title,
    body: input.body,
    shortName,
    stage: 'queued',
    priority: input.priority ?? 'normal',
    branch: branchName(shortName, policy.branchPrefix),
    policyVersion: pVersion,
    at,
  })

  await ctx.db.insert(mandates).values({
    id: newId(),
    projectId: input.project.id,
    ticketId: ticket.id,
    policyVersion: pVersion,
    strength: 'explicit',
    scope: input.scope,
    matchedRules: [],
    basis: { source: 'console', actorId: input.actor.id },
    requesterUserId: input.actor.id,
    createdAt: at,
  })

  if (input.channel !== null) {
    await ctx.db
      .insert(ticketSubscriptions)
      .values({
        id: newId(),
        projectId: input.project.id,
        ticketId: ticket.id,
        provider: input.channel.provider,
        channelId: input.channel.id,
        threadKey,
        kind: 'own',
        createdAt: at,
      })
      .onConflictDoNothing()
  }

  const initialInput = await insertTicketInput(ctx.db, {
    id: newId(),
    projectId: input.project.id,
    ticketId: ticket.id,
    source: 'person',
    kind: 'message',
    text: input.body,
    isPerson: true,
    at,
  })

  let turnId: string | null = null
  const used = await tokensUsedToday(ctx, input.project.id)
  if (input.project.status === 'active' && (policy.dailyTokenBudget <= 0 || used < policy.dailyTokenBudget)) {
    const sessionId = await ensureExecutorSession(ctx.db, input.project.id, ticket.id, at)
    const seq = await nextTurnSeq(ctx.db, ticket.id)
    const turn = await insertTurn(ctx.db, {
      id: newId(),
      projectId: input.project.id,
      sessionId,
      ticketId: ticket.id,
      seq,
      inputIds: [initialInput.id],
      at,
    })
    turnId = turn.id
    await ctx.queue.notify(turn.id).catch(() => {})
  }

  await audit(ctx, {
    projectId: input.project.id,
    actorId: input.actor.id,
    actorLabel: input.actor.name,
    action: 'ticket.created',
    target: `ticket:${ticket.id}`,
    metadata: { source: 'console', shortName, turnId },
  })

  return { ticket, turnId }
}

/** Approve a ticket's implementation plan and queue the next execution turn. */
export async function approveTicketPlan(
  ctx: CoreContext,
  projectId: string,
  ticketId: string,
  actor: { id: string; name: string },
  comment?: string,
): Promise<TicketRow> {
  const [ticket] = await ctx.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), eq(tickets.id, ticketId)))
  if (!ticket) throw notFound('工单不存在')
  const stage = (ticket.stage ?? 'queued') as TicketStage
  if (stage !== 'plan_review') throw conflict(`工单当前处于 ${stage} 阶段，无法批准计划`)

  const at = ctx.now()
  await ctx.db.insert(approvals).values({
    id: newId(),
    projectId,
    ticketId: ticket.id,
    kind: 'plan',
    actorId: actor.id,
    decision: 'approved',
    comment: comment ?? null,
    createdAt: at,
  })

  await ctx.db
    .update(tickets)
    .set({ planApprovedAt: at, updatedAt: at })
    .where(eq(tickets.id, ticket.id))

  const approvalInput = await insertTicketInput(ctx.db, {
    id: newId(),
    projectId,
    ticketId: ticket.id,
    source: 'approval',
    kind: 'approval',
    text: comment ? `计划已批准：${comment}` : '计划已批准，请继续执行。',
    isPerson: true,
    at,
  })

  const sessionId = await ensureExecutorSession(ctx.db, projectId, ticket.id, at)
  const seq = await nextTurnSeq(ctx.db, ticket.id)
  const turn = await insertTurn(ctx.db, {
    id: newId(),
    projectId,
    sessionId,
    ticketId: ticket.id,
    seq,
    inputIds: [approvalInput.id],
    at,
  })
  await ctx.queue.notify(turn.id).catch(() => {})

  const updated = await setTicketStage(ctx.db, ticket.id, nextStage('plan_review', { type: 'approve' }), at)
  await audit(ctx, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'ticket.plan_approved',
    target: `ticket:${ticket.id}`,
    metadata: { turnId: turn.id, comment: comment ?? null },
  })
  return updated ?? ticket
}

/** Stop/cancel a ticket, revoking its mandate and cancelling queued/running turns. */
export async function stopCoreTicket(
  ctx: CoreContext,
  projectId: string,
  ticketId: string,
  actor: { id: string; name: string },
  reason: string,
): Promise<TicketRow> {
  const [ticket] = await ctx.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), eq(tickets.id, ticketId)))
  if (!ticket) throw notFound('工单不存在')
  if (ticket.stage === 'cancelled') return ticket

  const at = ctx.now()
  await ctx.db
    .update(mandates)
    .set({ revokedAt: at })
    .where(eq(mandates.ticketId, ticket.id))
  await ctx.db
    .update(sessionTurns)
    .set({ status: 'cancelled', endedAt: at, error: 'ticket stopped' })
    .where(and(eq(sessionTurns.ticketId, ticket.id), eq(sessionTurns.status, 'queued')))
  await ctx.db
    .update(sessionTurns)
    .set({ cancelRequestedAt: at })
    .where(and(eq(sessionTurns.ticketId, ticket.id), eq(sessionTurns.status, 'running')))

  const updated = await setTicketStage(ctx.db, ticket.id, 'cancelled', at)
  await ctx.db
    .update(tickets)
    .set({ endedReason: reason, updatedAt: at })
    .where(eq(tickets.id, ticket.id))

  await audit(ctx, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'ticket.cancelled',
    target: `ticket:${ticket.id}`,
    metadata: { reason },
  })
  return updated ?? ticket
}

/** Retry a failed or blocked ticket by queuing a fresh execution turn. */
export async function retryCoreTicket(
  ctx: CoreContext,
  projectId: string,
  ticketId: string,
  actor: { id: string; name: string },
): Promise<TicketRow> {
  const [ticket] = await ctx.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), eq(tickets.id, ticketId)))
  if (!ticket) throw notFound('工单不存在')
  const stage = (ticket.stage ?? 'queued') as TicketStage
  if (stage !== 'failed' && stage !== 'blocked') {
    throw conflict(`工单当前处于 ${stage} 阶段，只有 failed / blocked 可以重试`)
  }

  const at = ctx.now()
  const sessionId = await ensureExecutorSession(ctx.db, projectId, ticket.id, at)
  const seq = await nextTurnSeq(ctx.db, ticket.id)
  const turn = await insertTurn(ctx.db, {
    id: newId(),
    projectId,
    sessionId,
    ticketId: ticket.id,
    seq,
    inputIds: [],
    at,
  })
  await ctx.queue.notify(turn.id).catch(() => {})

  const updated = await setTicketStage(ctx.db, ticket.id, nextStage(stage, { type: 'retry' }), at)
  await audit(ctx, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'ticket.retried',
    target: `ticket:${ticket.id}`,
    metadata: { turnId: turn.id },
  })
  return updated ?? ticket
}

/** Deliver an asynchronous input (e.g. GitHub PR comment) to a ticket and resume it if idle/review/done. */
export async function deliverTicketInput(
  ctx: CoreContext,
  project: ProjectRow,
  ticket: TicketRow,
  triggerId: string | null,
  text: string,
  isPerson: boolean,
  source: 'trigger' | 'person' | 'note' | 'policy' | 'approval' | 'system' = 'person',
): Promise<void> {
  const at = ctx.now()
  const kind: InputKind =
    source === 'approval'
      ? 'approval'
      : source === 'policy'
        ? 'policy'
        : source === 'note'
          ? 'note'
          : source === 'system'
            ? 'system'
            : 'message'

  const input = await insertTicketInput(ctx.db, {
    id: newId(),
    projectId: project.id,
    ticketId: ticket.id,
    triggerId,
    source,
    kind,
    text,
    isPerson,
    at,
  })

  const stage = (ticket.stage ?? 'queued') as TicketStage
  if (stage === 'cancelled' || stage === 'plan_review' || project.status !== 'active') return

  const [mandate] = await ctx.db.select().from(mandates).where(eq(mandates.ticketId, ticket.id))
  if (mandate?.revokedAt !== null && mandate?.revokedAt !== undefined) return

  if (stage !== 'queued' && stage !== 'working') {
    await setTicketStage(ctx.db, ticket.id, nextStage(stage, { type: 'input' }), at)
  }

  const [active] = await ctx.db
    .select({ id: sessionTurns.id })
    .from(sessionTurns)
    .where(and(eq(sessionTurns.ticketId, ticket.id), inArray(sessionTurns.status, ['queued', 'running'])))
    .limit(1)
  if (active === undefined) {
    const sessionId = await ensureExecutorSession(ctx.db, project.id, ticket.id, at)
    const seq = await nextTurnSeq(ctx.db, ticket.id)
    const turn = await insertTurn(ctx.db, {
      id: newId(),
      projectId: project.id,
      sessionId,
      ticketId: ticket.id,
      seq,
      inputIds: [input.id],
      at,
    })
    await ctx.queue.notify(turn.id).catch(() => {})
  }
}

/** Mark a ticket done after its PR is merged on GitHub. */
export async function markTicketMerged(ctx: CoreContext, ticketId: string, prUrl: string | null): Promise<void> {
  const [ticket] = await ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
  if (!ticket) return
  const at = ctx.now()
  await ctx.db
    .update(sessionTurns)
    .set({ status: 'cancelled', endedAt: at, error: 'pr merged' })
    .where(and(eq(sessionTurns.ticketId, ticket.id), eq(sessionTurns.status, 'queued')))
  await setTicketStage(ctx.db, ticket.id, 'done', at)
  await ctx.db
    .update(tickets)
    .set({
      ...(prUrl ? { prUrl } : {}),
      endedReason: 'pr_merged',
      updatedAt: at,
    })
    .where(eq(tickets.id, ticket.id))
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, ticket.projectId))
  if (project) {
    await notifications.done(ctx, { ...ticket, prUrl: prUrl ?? ticket.prUrl })
  }
}

/** Mark a ticket cancelled after its PR is closed without merging. */
export async function markTicketClosed(ctx: CoreContext, ticketId: string, prUrl: string | null): Promise<void> {
  const [ticket] = await ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
  if (!ticket) return
  const at = ctx.now()
  await ctx.db
    .update(sessionTurns)
    .set({ status: 'cancelled', endedAt: at, error: 'pr closed' })
    .where(and(eq(sessionTurns.ticketId, ticket.id), eq(sessionTurns.status, 'queued')))
  await setTicketStage(ctx.db, ticket.id, 'cancelled', at)
  await ctx.db
    .update(tickets)
    .set({
      ...(prUrl ? { prUrl } : {}),
      endedReason: 'pr_closed',
      updatedAt: at,
    })
    .where(eq(tickets.id, ticket.id))
}

/** Notify open tickets of a project policy update via a `policy` ticket input. */
export async function notifyPolicyChanged(
  ctx: CoreContext,
  project: ProjectRow,
  previousVersion: string,
  nextVersion: string,
): Promise<void> {
  if (previousVersion === nextVersion) return
  const at = ctx.now()
  const openTickets = await ctx.db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.projectId, project.id),
        inArray(tickets.stage, ['queued', 'working', 'plan_review', 'idle', 'review', 'answer', 'blocked']),
      ),
    )
  for (const ticket of openTickets) {
    await insertTicketInput(ctx.db, {
      id: newId(),
      projectId: project.id,
      ticketId: ticket.id,
      source: 'policy',
      kind: 'policy',
      text: `项目策略已更新（${previousVersion} → ${nextVersion}）。`,
      isPerson: false,
      at,
    })
  }
}

export async function findTurn(deps: Deps, turnId: string): Promise<TurnRow> {
  const [row] = await deps.db.select().from(sessionTurns).where(eq(sessionTurns.id, turnId))
  if (!row) throw notFound('运行不存在')
  return row
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
