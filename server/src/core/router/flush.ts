import { and, eq, inArray, sql } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import { bots, evaluations, roomBots, usage, type ProjectRow, type ThreadRow } from '../../db/schema.js'
import { newId } from '../../domain/ids.js'
import { dayKey } from '../../services/usage.js'
import type { TriggerAddress } from '../domain/types.js'
import { applyRouterOutput } from './apply.js'
import { renderBoard, type BoardBot, type BoardTicket, type BoardTrigger } from './board.js'
import type { RouterModel } from './model.js'
import { parseRouterOutput, validateRouterOutput } from './output.js'
import { releaseThread, releaseThreadLease } from '../store/threads.js'
import { listLiveTickets } from '../store/tickets.js'
import { listPendingTriggers, listRecentTriggers, setTriggerDisposition } from '../store/triggers.js'

export interface FlushThreadInput {
  db: Database
  project: ProjectRow
  thread: ThreadRow
  model: RouterModel
  policyVersion: string
  at: Date
  batchLimit?: number
  recentLimit?: number
  shortName?: () => string
}

export interface FlushThreadResult {
  runId: string | null
  decisionCount: number
  ticketIds: string[]
  turnIds: string[]
}

function toBoardTrigger(row: {
  id: string
  actorName: string | null
  text: string
  address: TriggerAddress
  kind?: string
  targetBotId?: string | null
  createdAt: Date
}): BoardTrigger {
  return {
    id: row.id,
    senderName: row.actorName,
    text: row.text,
    at: row.createdAt.toISOString(),
    address: row.address,
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.targetBotId !== undefined ? { targetBotId: row.targetBotId } : {}),
  }
}

/** Run one Router batch for a claimed thread and apply the decisions. */
export async function flushThread(input: FlushThreadInput): Promise<FlushThreadResult> {
  const scope = {
    projectId: input.project.id,
    channelId: input.thread.channelId,
    threadKey: input.thread.threadKey,
  }
  const batch = await listPendingTriggers(input.db, scope, input.batchLimit ?? 5)
  if (batch.length === 0) {
    await releaseThread(input.db, input.thread.id)
    return { runId: null, decisionCount: 0, ticketIds: [], turnIds: [] }
  }

  const runId = newId()
  await input.db.insert(evaluations).values({
    id: runId,
    projectId: input.project.id,
    channelId: input.thread.channelId,
    threadKey: input.thread.threadKey,
    policyVersion: input.policyVersion,
    status: 'running',
    triggerIds: batch.map((trigger) => trigger.id),
    model: input.model.name,
    startedAt: input.at,
    createdAt: input.at,
  })

  try {
    const recentRows = await listRecentTriggers(input.db, scope, input.recentLimit ?? 10)
    const batchIds = new Set(batch.map((trigger) => trigger.id))
    const roomId = batch.find((trigger) => trigger.roomId !== null)?.roomId ?? null

    let availableBotRows = await input.db
      .select()
      .from(bots)
      .where(and(eq(bots.projectId, input.project.id), eq(bots.status, 'active')))
    if (roomId !== null && availableBotRows.length > 0) {
      const members = await input.db.select({ botId: roomBots.botId }).from(roomBots).where(eq(roomBots.roomId, roomId))
      if (members.length > 0) {
        const memberSet = new Set(members.map((m) => m.botId))
        const filtered = availableBotRows.filter((b) => memberSet.has(b.id))
        if (filtered.length > 0) availableBotRows = filtered
      }
    }
    const botById = new Map(availableBotRows.map((b) => [b.id, b]))
    const boardBots: BoardBot[] = availableBotRows.map((bot) => ({
      id: bot.id,
      slug: bot.slug,
      name: bot.name,
      roleTitle: bot.roleTitle,
    }))

    const tickets = (await listLiveTickets(input.db, input.project.id)).filter(
      (ticket) => ticket.channelId === input.thread.channelId && ticket.threadKey === input.thread.threadKey,
    )
    const boardTickets: BoardTicket[] = tickets.map((ticket) => {
      const bot = ticket.botId ? botById.get(ticket.botId) : undefined
      return {
        id: ticket.id,
        shortName: ticket.shortName ?? ticket.id.slice(0, 8),
        title: ticket.title,
        stage: (ticket.stage ?? 'queued') as BoardTicket['stage'],
        ...(bot ? { botSlug: bot.slug } : {}),
      }
    })
    const board = renderBoard({
      project: {
        id: input.project.id,
        name: input.project.name,
        planApproval: input.project.policyJson.planApproval,
        allowThreadReplies: input.project.policyJson.allowThreadReplies,
      },
      thread: { key: input.thread.threadKey, summary: input.thread.summary },
      ...(boardBots.length > 0 ? { bots: boardBots } : {}),
      tickets: boardTickets,
      recent: recentRows.filter((row) => !batchIds.has(row.id)).map(toBoardTrigger),
      batch: batch.map(toBoardTrigger),
    })

    const raw = await input.model.decide({
      board,
      project: {
        id: input.project.id,
        name: input.project.name,
        planApproval: input.project.policyJson.planApproval,
        allowThreadReplies: input.project.policyJson.allowThreadReplies,
      },
      ...(boardBots.length > 0 ? { bots: boardBots } : {}),
      tickets: boardTickets,
      batch: batch.map(toBoardTrigger),
    })
    const parsed = parseRouterOutput(raw)
    const output = raw.usage === undefined ? parsed : { ...parsed, usage: raw.usage }
    validateRouterOutput(output, batch.map((trigger) => trigger.id))
    const applied = await applyRouterOutput(input.db, {
      projectId: input.project.id,
      channelId: input.thread.channelId,
      threadKey: input.thread.threadKey,
      provider: batch[0]?.provider ?? 'unknown',
      policyVersion: input.policyVersion,
      runId,
      batch,
      output,
      at: input.at,
      ...(input.shortName === undefined ? {} : { shortName: input.shortName }),
    })

    await input.db
      .update(evaluations)
      .set({
        status: 'decided',
        summary: output.summary,
        promptTokens: output.usage?.promptTokens ?? null,
        outputTokens: output.usage?.outputTokens ?? null,
        endedAt: input.at,
      })
      .where(eq(evaluations.id, runId))
    if (output.usage !== undefined && output.usage.totalTokens > 0) {
      const day = dayKey(input.at)
      const tokens = output.usage.totalTokens
      const cost = output.usage.cost ?? 0
      await input.db
        .insert(usage)
        .values({ id: newId(), projectId: input.project.id, day, runs: 0, tokens, cost })
        .onConflictDoUpdate({
          target: [usage.projectId, usage.day],
          set: {
            tokens: sql`${usage.tokens} + ${tokens}`,
            cost: sql`${usage.cost} + ${cost}`,
          },
        })
    }
    await releaseThread(input.db, input.thread.id, output.summary)
    return { runId, ...applied }
  } catch (error) {
    await input.db
      .update(evaluations)
      .set({
        status: 'unavailable',
        reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        endedAt: input.at,
      })
      .where(eq(evaluations.id, runId))
    for (const trigger of batch) {
      await setTriggerDisposition(input.db, trigger.id, 'pending_review')
    }
    await releaseThreadLease(input.db, input.thread.id)
    await releaseThread(input.db, input.thread.id)
    throw error
  }
}
