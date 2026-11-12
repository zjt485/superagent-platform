import { and, eq, lte, sql } from 'drizzle-orm'
import type { Deps } from './deps.js'
import { channels, outboxEvents, type OutboxRow } from '../db/schema.js'
import type { OutboxMessage } from '../domain/outbox.js'
import { newId } from '../domain/ids.js'
import type { ChannelProvider } from '../domain/status.js'
import type { SendMessageInput, SendMessageResult } from '../domain/im.js'
import { audit } from './audit.js'

export interface EnqueueOutboxInput {
  projectId: string
  channelId: string | null
  kind: string
  message: OutboxMessage
  dedupeKey?: string
}

export async function enqueueOutbox(deps: Deps, input: EnqueueOutboxInput): Promise<void> {
  try {
    await deps.db
      .insert(outboxEvents)
      .values({
        id: newId(),
        projectId: input.projectId,
        channelId: input.channelId,
        kind: input.kind,
        dedupeKey: input.dedupeKey ?? null,
        payload: input.message,
        status: 'pending',
        nextAttemptAt: deps.now(),
        createdAt: deps.now(),
      })
      .onConflictDoNothing({ target: outboxEvents.dedupeKey })
  } catch (error) {
    // A notification must never fail the business transaction it belongs to.
    deps.log.error({ err: error, kind: input.kind, projectId: input.projectId }, 'failed to enqueue outbox message')
  }
}

export interface OutboxSender {
  provider: ChannelProvider
  send(input: SendMessageInput): Promise<SendMessageResult>
}

/** Claims and sends pending outbox rows; safe to run in the API process. */
export async function flushOutbox(deps: Deps, senders: Map<ChannelProvider, OutboxSender>, limit: number): Promise<number> {
  const due = await deps.db
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.status, 'pending'), lte(outboxEvents.nextAttemptAt, deps.now())))
    .orderBy(outboxEvents.createdAt)
    .limit(limit)
  let sent = 0
  for (const row of due) {
    const claimed = await claim(deps, row)
    if (!claimed) continue
    const outcome = await deliver(deps, claimed, senders)
    if (outcome) sent += 1
  }
  return sent
}

async function claim(deps: Deps, row: OutboxRow): Promise<OutboxRow | null> {
  const [claimed] = await deps.db
    .update(outboxEvents)
    .set({ status: 'pending', attempts: sql`${outboxEvents.attempts} + 1` })
    .where(and(eq(outboxEvents.id, row.id), eq(outboxEvents.status, 'pending'), eq(outboxEvents.attempts, row.attempts)))
    .returning()
  return claimed ?? null
}

async function deliver(deps: Deps, row: OutboxRow, senders: Map<ChannelProvider, OutboxSender>): Promise<boolean> {
  try {
    if (!row.channelId) throw new Error('outbox message has no channel')
    const [channel] = await deps.db.select().from(channels).where(eq(channels.id, row.channelId))
    if (!channel || channel.status !== 'active') throw new Error('channel is not active')
    const sender = senders.get(channel.provider)
    if (!sender) {
      // No credentials configured for this provider: record the delivery as
      // simulated instead of retrying forever (demo and development mode).
      await deps.db
        .update(outboxEvents)
        .set({ status: 'sent', sentAt: deps.now(), lastError: 'simulated: no adapter configured' })
        .where(eq(outboxEvents.id, row.id))
      deps.log.info({ channelId: channel.id, kind: row.kind, text: row.payload.text }, 'simulated IM notification')
      return true
    }
    const result = await sender.send({
      chatId: channel.externalChatId,
      text: row.payload.text,
      ...(row.payload.replyToMessageId ? { replyToMessageId: row.payload.replyToMessageId } : {}),
      ...(row.payload.card ? { card: row.payload.card } : {}),
      channelConfig: channel.config,
    })
    await deps.db.update(outboxEvents).set({ status: 'sent', sentAt: deps.now(), lastError: null }).where(eq(outboxEvents.id, row.id))
    await audit(deps, {
      projectId: row.projectId,
      action: 'notification.sent',
      target: `channel:${channel.id}`,
      metadata: { kind: row.kind, provider: channel.provider, messageId: result.messageId ?? null },
    })
    return true
  } catch (error) {
    const attempts = row.attempts
    const max = deps.config.OUTBOX_MAX_ATTEMPTS
    const failed = attempts >= max
    const delayMs = Math.min(2 ** attempts * 1000, 5 * 60_000)
    await deps.db
      .update(outboxEvents)
      .set({
        status: failed ? 'failed' : 'pending',
        lastError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        nextAttemptAt: new Date(deps.now().getTime() + delayMs),
      })
      .where(eq(outboxEvents.id, row.id))
    deps.log.warn({ err: error, outboxId: row.id, attempts, failed }, 'IM notification delivery failed')
    return false
  }
}
