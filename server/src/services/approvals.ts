import { and, desc, eq, inArray } from 'drizzle-orm'

import type { CoreContext } from '../core/operations.js'
import type { Deps } from './deps.js'
import { audit } from './audit.js'
import { requireProjectAccess } from './access.js'
import { defaultEventBus } from './events.js'
import { appendRoomMessage } from './rooms.js'
import { newId } from '../domain/ids.js'
import { conflict, notFound } from '../errors.js'
import {
  actionApprovals,
  bots,
  rooms,
  sessionTurns,
  tickets,
  users,
  type ActionApprovalRow,
} from '../db/schema.js'
import { nextStage } from '../core/domain/stage.js'
import { insertTicketInput } from '../core/store/inputs.js'
import { ensureExecutorSession } from '../core/store/sessions.js'
import { setTicketStage } from '../core/store/tickets.js'
import { insertTurn, nextTurnSeq } from '../core/store/turns.js'

export interface HydratedActionApproval extends ActionApprovalRow {
  botName: string | null
  botSlug: string | null
  botAvatar: string | null
  ticketTitle: string | null
  ticketShortName: string | null
  roomName: string | null
  decidedByName: string | null
}

export async function listActionApprovals(
  deps: Deps,
  projectId: string,
  status?: ActionApprovalRow['status'],
): Promise<HydratedActionApproval[]> {
  const conditions = [eq(actionApprovals.projectId, projectId)]
  if (status) conditions.push(eq(actionApprovals.status, status))
  const rows = await deps.db
    .select()
    .from(actionApprovals)
    .where(and(...conditions))
    .orderBy(desc(actionApprovals.createdAt))
    .limit(100)

  if (rows.length === 0) return []
  const botIds = [...new Set(rows.map((r) => r.botId).filter((v): v is string => Boolean(v)))]
  const ticketIds = [...new Set(rows.map((r) => r.ticketId))]
  const roomIds = [...new Set(rows.map((r) => r.roomId).filter((v): v is string => Boolean(v)))]
  const userIds = [...new Set(rows.map((r) => r.decidedBy).filter((v): v is string => Boolean(v)))]

  const [botRows, ticketRows, roomRows, userRows] = await Promise.all([
    botIds.length > 0 ? deps.db.select().from(bots).where(inArray(bots.id, botIds)) : [],
    ticketIds.length > 0 ? deps.db.select().from(tickets).where(inArray(tickets.id, ticketIds)) : [],
    roomIds.length > 0 ? deps.db.select().from(rooms).where(inArray(rooms.id, roomIds)) : [],
    userIds.length > 0 ? deps.db.select().from(users).where(inArray(users.id, userIds)) : [],
  ])

  const botMap = new Map(botRows.map((b) => [b.id, b]))
  const ticketMap = new Map(ticketRows.map((t) => [t.id, t]))
  const roomMap = new Map(roomRows.map((r) => [r.id, r]))
  const userMap = new Map(userRows.map((u) => [u.id, u]))

  return rows.map((row) => {
    const bot = row.botId ? botMap.get(row.botId) : undefined
    const ticket = ticketMap.get(row.ticketId)
    const room = row.roomId ? roomMap.get(row.roomId) : undefined
    const decider = row.decidedBy ? userMap.get(row.decidedBy) : undefined
    return {
      ...row,
      botName: bot?.name ?? null,
      botSlug: bot?.slug ?? null,
      botAvatar: bot?.avatar ?? null,
      ticketTitle: ticket?.title ?? null,
      ticketShortName: ticket?.shortName ?? null,
      roomName: room?.name ?? null,
      decidedByName: decider?.name ?? null,
    }
  })
}

export interface DecideApprovalInput {
  decision: 'approved' | 'rejected' | 'revision_requested'
  comment?: string
}

/**
 * Decide a pending tool-level approval and queue a `resume` Turn that restores
 * the paused checkpoint cleanly without holding a worker slot while waiting.
 */
export async function decideActionApproval(
  ctx: CoreContext,
  projectId: string,
  approvalId: string,
  actor: { id: string; name: string; isAdmin: boolean },
  input: DecideApprovalInput,
): Promise<{ approval: ActionApprovalRow; resumeTurnId: string }> {
  await requireProjectAccess(ctx, projectId, actor.id, actor.isAdmin, 'maintainer')
  const [approval] = await ctx.db
    .select()
    .from(actionApprovals)
    .where(and(eq(actionApprovals.projectId, projectId), eq(actionApprovals.id, approvalId)))
  if (!approval) throw notFound('审批单不存在')
  if (approval.status !== 'pending') throw conflict(`审批单状态已为 ${approval.status}，无法重复操作`)

  const at = ctx.now()
  const [updated] = await ctx.db
    .update(actionApprovals)
    .set({
      status: input.decision,
      decidedBy: actor.id,
      decisionComment: input.comment?.trim() || null,
      decidedAt: at,
    })
    .where(and(eq(actionApprovals.id, approval.id), eq(actionApprovals.status, 'pending')))
    .returning()
  if (!updated) throw conflict('审批单已被其他人处理')

  // Mark paused turn as succeeded so the session can run the resume turn.
  await ctx.db
    .update(sessionTurns)
    .set({ status: 'succeeded', endedAt: at })
    .where(and(eq(sessionTurns.id, approval.turnId), eq(sessionTurns.status, 'waiting_approval')))

  const label =
    input.decision === 'approved'
      ? '已批准执行'
      : input.decision === 'revision_requested'
        ? '已打回要求修改'
        : '已拒绝执行'
  const note = input.comment?.trim() ? `${label}（${input.comment.trim()}）` : label

  const approvalInput = await insertTicketInput(ctx.db, {
    id: newId(),
    projectId,
    ticketId: approval.ticketId,
    source: 'approval',
    kind: 'approval',
    text: `${actor.name} 对「${approval.title}」${note}`,
    isPerson: true,
    at,
  })

  const sessionId = await ensureExecutorSession(ctx.db, projectId, approval.ticketId, at)
  const seq = await nextTurnSeq(ctx.db, approval.ticketId)
  const resumeTurn = await insertTurn(ctx.db, {
    id: newId(),
    projectId,
    sessionId,
    ticketId: approval.ticketId,
    botId: approval.botId,
    kind: 'resume',
    seq,
    inputIds: [approvalInput.id],
    at,
  })
  await ctx.db
    .update(sessionTurns)
    .set({
      input: {
        inputIds: [approvalInput.id],
        approvalId: approval.id,
        sourceTurnId: approval.turnId,
        decision: input.decision,
        comment: input.comment?.trim() || null,
      },
    })
    .where(eq(sessionTurns.id, resumeTurn.id))

  const [ticket] = await ctx.db.select().from(tickets).where(eq(tickets.id, approval.ticketId))
  if (ticket && ticket.stage === 'waiting_approval') {
    const stageEvent =
      input.decision === 'approved'
        ? ({ type: 'approve' } as const)
        : input.decision === 'revision_requested'
          ? ({ type: 'revise' } as const)
          : ({ type: 'reject' } as const)
    await setTicketStage(ctx.db, ticket.id, nextStage('waiting_approval', stageEvent), at)
  }

  await ctx.queue.notify(resumeTurn.id).catch(() => {})

  const bus = ctx.events ?? defaultEventBus
  bus.publish(projectId, 'approval.resolved', {
    approvalId: approval.id,
    ticketId: approval.ticketId,
    decision: input.decision,
    actorName: actor.name,
    comment: input.comment?.trim() || null,
    resumeTurnId: resumeTurn.id,
  })

  if (approval.roomId) {
    await appendRoomMessage(ctx.db, {
      projectId,
      roomId: approval.roomId,
      threadKey: ticket?.threadKey ?? `room:${approval.roomId}`,
      authorKind: 'system',
      kind: 'status',
      content: `${actor.name} ${note}「${approval.title}」，Bot 正在从断点恢复执行。`,
      ticketId: approval.ticketId,
      turnId: resumeTurn.id,
      syncToIm: true,
      dedupeKey: `approval-resolved:${approval.id}`,
      at,
      events: bus,
    })
  }

  await audit(ctx, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: `approval.${input.decision}`,
    target: `approval:${approval.id}`,
    metadata: { ticketId: approval.ticketId, toolName: approval.toolName, resumeTurnId: resumeTurn.id },
  })

  return { approval: updated, resumeTurnId: resumeTurn.id }
}
