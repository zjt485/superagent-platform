import { and, eq, lt, sql } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import { agentSessions, outboxEvents, sessionTurns, tickets } from '../../db/schema.js'
import { newId } from '../../domain/ids.js'
import { setTicketStage } from '../store/tickets.js'

export interface ReapCoreTurnsOptions {
  db: Database
  now: () => Date
  leaseSeconds?: number
}

/**
 * Mark running core turns whose heartbeat expired as `timeout`, release their
 * sessions, and move their tickets to `failed` with an outbox notification.
 */
export async function reapStaleCoreTurns(options: ReapCoreTurnsOptions): Promise<number> {
  const at = options.now()
  const leaseSeconds = options.leaseSeconds ?? 120
  const cutoff = new Date(at.getTime() - leaseSeconds * 1000)

  const stale = await options.db
    .select()
    .from(sessionTurns)
    .where(
      and(
        eq(sessionTurns.status, 'running'),
        lt(sql`coalesce(${sessionTurns.heartbeatAt}, ${sessionTurns.startedAt}, ${sessionTurns.createdAt})`, cutoff),
      ),
    )

  let reaped = 0
  for (const turn of stale) {
    const [updated] = await options.db
      .update(sessionTurns)
      .set({
        status: 'timeout',
        error: `Turn 心跳超时（超过 ${leaseSeconds}s 未响应）`,
        endedAt: at,
      })
      .where(and(eq(sessionTurns.id, turn.id), eq(sessionTurns.status, 'running')))
      .returning()
    if (updated === undefined) continue
    reaped += 1

    await options.db
      .update(agentSessions)
      .set({ status: 'idle', updatedAt: at })
      .where(eq(agentSessions.id, turn.sessionId))

    if (turn.ticketId !== null) {
      const [ticket] = await options.db.select().from(tickets).where(eq(tickets.id, turn.ticketId))
      if (ticket !== undefined && ticket.stage === 'working') {
        await setTicketStage(options.db, ticket.id, 'failed', at)
        if (ticket.channelId !== null) {
          await options.db
            .insert(outboxEvents)
            .values({
              id: newId(),
              projectId: ticket.projectId,
              channelId: ticket.channelId,
              kind: 'failed',
              dedupeKey: `timeout:${turn.id}`,
              payload: {
                text: `工单「${ticket.title}」（${ticket.shortName ?? ticket.id.slice(0, 8)}）执行超时，已标记为失败，可发送 /retry 重试。`,
              },
              status: 'pending',
              nextAttemptAt: at,
              createdAt: at,
            })
            .onConflictDoNothing({ target: outboxEvents.dedupeKey })
        }
      }
    }
  }

  return reaped
}
