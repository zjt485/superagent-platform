import { and, desc, eq, isNull } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import { outboxEvents, sessionTurns, tickets, type TicketRow } from '../db/schema.js'
import { newId } from '../domain/ids.js'
import type { ParsedCommand } from '../domain/intake.js'
import { atLeast, type MemberRole } from '../domain/status.js'
import { nextStage } from './domain/stage.js'
import type { TicketStage } from './domain/types.js'
import { insertTicketInput } from './store/inputs.js'
import { ensureExecutorSession } from './store/sessions.js'
import { setTicketStage } from './store/tickets.js'
import { insertTurn, nextTurnSeq } from './store/turns.js'

export interface CoreCommandInput {
  db: Database
  projectId: string
  channelId: string | null
  threadKey: string
  role: MemberRole | null
  command: ParsedCommand
  at: Date
  dedupeKey?: string
}

export interface CoreCommandResult {
  action: 'command' | 'ignored'
  reply?: string
  reason?: string
}

async function ticketsForThread(input: CoreCommandInput): Promise<TicketRow[]> {
  const arg = input.command.arg?.trim()
  if (arg) {
    const byShort = await input.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.projectId, input.projectId), eq(tickets.shortName, arg.toLowerCase())))
      .orderBy(desc(tickets.updatedAt))
    if (byShort.length > 0) return byShort
  }

  const conditions = [
    eq(tickets.projectId, input.projectId),
    eq(tickets.threadKey, input.threadKey),
    input.channelId === null ? isNull(tickets.channelId) : eq(tickets.channelId, input.channelId),
  ]
  const inThread = await input.db.select().from(tickets).where(and(...conditions)).orderBy(desc(tickets.updatedAt))
  if (inThread.length > 0) return inThread

  // Providers without native threads (e.g. WeCom) issue a fresh threadKey per
  // message; fall back to the latest ticket in the same bound channel.
  if (input.channelId !== null) {
    return input.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.projectId, input.projectId), eq(tickets.channelId, input.channelId)))
      .orderBy(desc(tickets.updatedAt))
      .limit(5)
  }
  return []
}

async function reply(input: CoreCommandInput, ticketId: string | null, text: string): Promise<void> {
  await input.db
    .insert(outboxEvents)
    .values({
      id: newId(),
      projectId: input.projectId,
      channelId: input.channelId,
      kind: 'command',
      dedupeKey: input.dedupeKey ?? `cmd:${newId()}`,
      payload: { text },
      status: 'pending',
      nextAttemptAt: input.at,
      createdAt: input.at,
    })
    .onConflictDoNothing({ target: outboxEvents.dedupeKey })
  void ticketId
}

/** Deterministic commands over the core ticket model. */
export async function handleCoreCommand(input: CoreCommandInput): Promise<CoreCommandResult> {
  const rows = await ticketsForThread(input)
  const ticket = rows[0]

  if (input.command.name === 'unknown') return { action: 'ignored', reason: 'unknown_command' }
  if (!atLeast(input.role, 'viewer')) return { action: 'ignored', reason: 'not_member' }

  if (input.command.name === 'help') {
    await reply(input, ticket?.id ?? null, '命令：/status /approve /cancel /retry')
    return { action: 'command', reply: 'help' }
  }

  if (input.command.name === 'status') {
    const text =
      ticket === undefined
        ? '当前线程没有工单。'
        : `${ticket.shortName ?? ticket.id} · ${ticket.stage ?? 'unknown'} · ${ticket.title}`
    await reply(input, ticket?.id ?? null, text)
    return { action: 'command', reply: text }
  }

  if (ticket === undefined) {
    await reply(input, null, '当前线程没有可操作的工单。')
    return { action: 'command', reply: 'no_ticket' }
  }

  const stage = (ticket.stage ?? 'queued') as TicketStage

  if (input.command.name === 'approve') {
    if (!atLeast(input.role, 'maintainer')) return { action: 'ignored', reason: 'insufficient_role' }
    if (stage !== 'plan_review') {
      await reply(input, ticket.id, '当前工单不在计划审批阶段。')
      return { action: 'command', reply: 'not_plan_review' }
    }
    const approval = await insertTicketInput(input.db, {
      id: newId(),
      projectId: input.projectId,
      ticketId: ticket.id,
      source: 'approval',
      kind: 'approval',
      text: 'approved',
      isPerson: true,
      at: input.at,
    })
    const sessionId = await ensureExecutorSession(input.db, input.projectId, ticket.id, input.at)
    const seq = await nextTurnSeq(input.db, ticket.id)
    await insertTurn(input.db, {
      id: newId(),
      projectId: input.projectId,
      sessionId,
      ticketId: ticket.id,
      seq,
      inputIds: [approval.id],
      at: input.at,
    })
    await setTicketStage(input.db, ticket.id, nextStage('plan_review', { type: 'approve' }), input.at)
    await reply(input, ticket.id, `已批准 ${ticket.shortName ?? ticket.id} 的计划，下一回合继续。`)
    return { action: 'command', reply: 'approved' }
  }

  if (input.command.name === 'cancel') {
    if (!atLeast(input.role, 'maintainer')) return { action: 'ignored', reason: 'insufficient_role' }
    await setTicketStage(input.db, ticket.id, 'cancelled', input.at)
    await input.db
      .update(sessionTurns)
      .set({ status: 'cancelled', endedAt: input.at })
      .where(and(eq(sessionTurns.ticketId, ticket.id), eq(sessionTurns.status, 'queued')))
    await reply(input, ticket.id, `已取消 ${ticket.shortName ?? ticket.id}。`)
    return { action: 'command', reply: 'cancelled' }
  }

  if (input.command.name === 'retry') {
    if (!atLeast(input.role, 'maintainer')) return { action: 'ignored', reason: 'insufficient_role' }
    if (stage !== 'failed' && stage !== 'blocked') {
      await reply(input, ticket.id, '只有 failed / blocked 工单可以重试。')
      return { action: 'command', reply: 'not_retryable' }
    }
    const sessionId = await ensureExecutorSession(input.db, input.projectId, ticket.id, input.at)
    const seq = await nextTurnSeq(input.db, ticket.id)
    await insertTurn(input.db, {
      id: newId(),
      projectId: input.projectId,
      sessionId,
      ticketId: ticket.id,
      seq,
      inputIds: [],
      at: input.at,
    })
    await setTicketStage(input.db, ticket.id, nextStage(stage, { type: 'retry' }), input.at)
    await reply(input, ticket.id, `已重新排队 ${ticket.shortName ?? ticket.id}。`)
    return { action: 'command', reply: 'retried' }
  }

  return { action: 'ignored', reason: 'unhandled_command' }
}
