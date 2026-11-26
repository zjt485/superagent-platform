import { and, eq, inArray } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import {
  bots,
  decisions,
  mandates,
  outboxEvents,
  roomMessages,
  sessionTurns,
  ticketSubscriptions,
  tickets,
  type BotRow,
  type TriggerRow,
} from '../../db/schema.js'
import { newId } from '../../domain/ids.js'
import { formatBotSignature } from '../../services/bots.js'
import { defaultEventBus } from '../../services/events.js'
import { hydrateRoomMessages } from '../../services/rooms.js'
import { nextStage } from '../domain/stage.js'
import { branchName, ticketShortName } from '../domain/ids.js'
import type { RouterOutput, TicketStage } from '../domain/types.js'
import { insertDecisions } from '../store/decisions.js'
import { insertTicketInput } from '../store/inputs.js'
import { ensureExecutorSession } from '../store/sessions.js'
import { insertTicket, getTicketByShortName, setTicketStage } from '../store/tickets.js'
import { insertTurn, nextTurnSeq } from '../store/turns.js'
import { setTriggerDisposition, setTriggerEvaluation } from '../store/triggers.js'
import { validateRouterOutput } from './output.js'

export interface ApplyRouterOutputInput {
  projectId: string
  channelId: string | null
  threadKey: string
  provider: string
  policyVersion: string
  runId: string
  batch: TriggerRow[]
  output: RouterOutput
  at: Date
  shortName?: () => string
}

export interface ApplyRouterOutputResult {
  ticketIds: string[]
  turnIds: string[]
  decisionCount: number
}

export class RouterApplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RouterApplyError'
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  )
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function resolveAssignedBot(
  db: Database,
  projectId: string,
  candidates: { botId?: string | null; botSlug?: string | null },
): Promise<BotRow | null> {
  if (candidates.botId && UUID_PATTERN.test(candidates.botId)) {
    const [byId] = await db
      .select()
      .from(bots)
      .where(and(eq(bots.projectId, projectId), eq(bots.id, candidates.botId), eq(bots.status, 'active')))
    if (byId) return byId
  }
  if (candidates.botSlug) {
    const [bySlug] = await db
      .select()
      .from(bots)
      .where(and(eq(bots.projectId, projectId), eq(bots.slug, candidates.botSlug.toLowerCase()), eq(bots.status, 'active')))
    if (bySlug) return bySlug
  }
  return null
}

async function resolveTargetTicket(
  db: Database,
  projectId: string,
  ref: string,
) {
  if (UUID_PATTERN.test(ref)) {
    const [byId] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ref), eq(tickets.projectId, projectId)))
    if (byId !== undefined) return byId
  }
  return (await getTicketByShortName(db, projectId, ref)) ?? (await getTicketByShortName(db, projectId, ref.toLowerCase()))
}

/** Apply a validated Router batch in one transaction. Replays are idempotent. */
export async function applyRouterOutput(
  db: Database,
  input: ApplyRouterOutputInput,
): Promise<ApplyRouterOutputResult> {
  validateRouterOutput(input.output, input.batch.map((trigger) => trigger.id))
  const byId = new Map(input.batch.map((trigger) => [trigger.id, trigger]))
  const nextShortName = input.shortName ?? ticketShortName

  return db.transaction(async (tx) => {
    const d = tx as unknown as Database
    const existing = await tx
      .select({ triggerId: decisions.triggerId })
      .from(decisions)
      .where(inArray(decisions.triggerId, input.batch.map((trigger) => trigger.id)))
    const seen = new Set(existing.map((row) => row.triggerId))
    const fresh = input.output.items.filter((item) => !seen.has(item.triggerId))

    const resolvedTargets = new Map<string, typeof tickets.$inferSelect>()
    for (const item of fresh) {
      if (item.action !== 'attach' && item.action !== 'stop') continue
      if (item.ticketId === undefined) throw new RouterApplyError(`decision ${item.triggerId} has no ticketId`)
      const target = await resolveTargetTicket(d, input.projectId, item.ticketId)
      if (target === undefined) throw new RouterApplyError(`unknown ticket: ${item.ticketId}`)
      resolvedTargets.set(item.triggerId, target)
    }

    await insertDecisions(
      d,
      fresh.map((item) => ({
        id: newId(),
        projectId: input.projectId,
        runId: input.runId,
        triggerId: item.triggerId,
        threadKey: input.threadKey,
        action: item.action,
        ticketId: resolvedTargets.get(item.triggerId)?.id ?? null,
        title: item.title ?? null,
        reason: item.reason,
        confidence: item.confidence ?? null,
        payload: item as unknown as Record<string, unknown>,
        decidedAt: input.at,
      })),
    )

    const ticketIds: string[] = []
    const turnIds: string[] = []

    for (const item of fresh) {
      const trigger = byId.get(item.triggerId)
      if (trigger === undefined) continue

      if (item.action === 'ignore') {
        await setTriggerDisposition(d, trigger.id, 'ignored')
        continue
      }
      if (item.action === 'command') {
        await setTriggerDisposition(d, trigger.id, 'command')
        continue
      }

      if (item.action === 'new') {
        const title = item.title ?? trigger.text
        const assignedBot = await resolveAssignedBot(d, input.projectId, {
          botId: item.botId ?? trigger.targetBotId,
          botSlug: item.botSlug,
        })
        const chainId = trigger.handoffChainId ?? newId()
        let shortName = nextShortName()
        let ticketId = newId()
        let created = false
        for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
          try {
            await insertTicket(d, {
              id: ticketId,
              projectId: input.projectId,
              channelId: input.channelId,
              roomId: trigger.roomId ?? null,
              botId: assignedBot?.id ?? null,
              handoffChainId: chainId,
              handoffHop: trigger.handoffHop ?? 0,
              threadKey: input.threadKey,
              requesterId: trigger.actorUserId,
              requesterName: trigger.actorName,
              title,
              body: item.body ?? trigger.text,
              shortName,
              stage: 'queued',
              branch: branchName(shortName),
              baseRef: null,
              policyVersion: input.policyVersion,
              originTriggerId: trigger.id,
              at: input.at,
            })
            created = true
          } catch (error) {
            if (!isUniqueViolation(error)) throw error
            shortName = nextShortName()
            ticketId = newId()
          }
        }
        if (!created) throw new RouterApplyError(`could not allocate a unique short name for ${trigger.id}`)

        await tx.insert(mandates).values({
          id: newId(),
          projectId: input.projectId,
          ticketId,
          policyVersion: input.policyVersion,
          strength: 'explicit',
          scope: item.scope ?? title,
          matchedRules: [],
          basis: { triggerId: trigger.id, decisionId: item.triggerId, botSlug: assignedBot?.slug ?? null },
          requesterTriggerId: trigger.id,
          requesterUserId: trigger.actorUserId,
          createdAt: input.at,
        })
        await tx.insert(ticketSubscriptions).values({
          id: newId(),
          projectId: input.projectId,
          ticketId,
          provider: input.provider,
          channelId: input.channelId,
          threadKey: input.threadKey,
          kind: 'own',
          createdAt: input.at,
        })

        const sessionId = await ensureExecutorSession(d, input.projectId, ticketId, input.at)
        const ticketInput = await insertTicketInput(d, {
          id: newId(),
          projectId: input.projectId,
          ticketId,
          triggerId: trigger.id,
          source: 'trigger',
          kind: 'message',
          text: trigger.text,
          isPerson: trigger.kind !== 'handoff' && trigger.kind !== 'routine',
          at: input.at,
        })
        const turn = await insertTurn(d, {
          id: newId(),
          projectId: input.projectId,
          sessionId,
          ticketId,
          botId: assignedBot?.id ?? null,
          model: assignedBot?.modelConfig?.model ?? null,
          seq: 1,
          inputIds: [ticketInput.id],
          at: input.at,
        })
        const ackBody = `已接单：${title}（${shortName}）`
        if (input.channelId !== null) {
          await tx
            .insert(outboxEvents)
            .values({
              id: newId(),
              projectId: input.projectId,
              channelId: input.channelId,
              kind: 'ack',
              dedupeKey: `ack:${trigger.id}`,
              payload: { text: formatBotSignature(assignedBot, ackBody) },
              status: 'pending',
              nextAttemptAt: input.at,
              createdAt: input.at,
            })
            .onConflictDoNothing({ target: outboxEvents.dedupeKey })
        }
        if (trigger.roomId) {
          const [rm] = await tx
            .insert(roomMessages)
            .values({
              id: newId(),
              projectId: input.projectId,
              roomId: trigger.roomId,
              threadKey: input.threadKey,
              authorKind: assignedBot ? 'bot' : 'system',
              authorBotId: assignedBot?.id ?? null,
              kind: 'status',
              content: ackBody,
              attachments: [],
              ticketId,
              turnId: turn.id,
              createdAt: input.at,
            })
            .returning()
          if (rm) {
            const [hydrated] = await hydrateRoomMessages(d, [rm])
            defaultEventBus.publish(input.projectId, 'room.message', { roomId: trigger.roomId, message: hydrated })
          }
        }
        await setTriggerDisposition(d, trigger.id, 'new_ticket')
        await setTriggerEvaluation(d, trigger.id, input.runId)
        ticketIds.push(ticketId)
        turnIds.push(turn.id)
        continue
      }

      const ticket = resolvedTargets.get(item.triggerId)
      if (ticket === undefined) throw new RouterApplyError(`unknown ticket: ${item.ticketId ?? ''}`)
      const ticketId = ticket.id

      if (item.action === 'stop') {
        await setTicketStage(d, ticketId, 'cancelled', input.at)
        await tx
          .update(sessionTurns)
          .set({ status: 'cancelled', endedAt: input.at })
          .where(and(eq(sessionTurns.ticketId, ticketId), eq(sessionTurns.status, 'queued')))
        await setTriggerDisposition(d, trigger.id, 'stopped')
        continue
      }

      if (item.action === 'attach') {
        const ticketInput = await insertTicketInput(d, {
          id: newId(),
          projectId: input.projectId,
          ticketId,
          triggerId: trigger.id,
          source: 'trigger',
          kind: 'message',
          text: trigger.text,
          isPerson: true,
          at: input.at,
        })
        const sessionId = await ensureExecutorSession(d, input.projectId, ticketId, input.at)
        const seq = await nextTurnSeq(d, ticketId)
        const turn = await insertTurn(d, {
          id: newId(),
          projectId: input.projectId,
          sessionId,
          ticketId,
          seq,
          inputIds: [ticketInput.id],
          at: input.at,
        })
        const current = (ticket.stage ?? 'queued') as TicketStage
        if (current === 'cancelled') {
          throw new RouterApplyError(`cannot attach to cancelled ticket: ${ticketId}`)
        }
        if (current !== 'queued' && current !== 'working' && current !== 'plan_review') {
          await setTicketStage(d, ticketId, nextStage(current, { type: 'input' }), input.at)
        }
        await setTriggerDisposition(d, trigger.id, 'attached')
        turnIds.push(turn.id)
      }
    }

    return { ticketIds, turnIds, decisionCount: fresh.length }
  })
}
