import { and, asc, desc, eq } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import { triggers, type TriggerRow } from '../../db/schema.js'
import type { TriggerAddress, TriggerDisposition } from '../domain/types.js'

export interface NewTrigger {
  id: string
  projectId: string
  channelId: string | null
  roomId?: string | null
  provider: string
  externalId: string
  kind?: 'message' | 'command' | 'ci' | 'pr_comment' | 'pr_merge' | 'pr_close' | 'resume' | 'handoff' | 'routine'
  messageId?: string | null
  threadKey: string
  actorUserId?: string | null
  actorExternalId?: string | null
  actorName?: string | null
  text: string
  isBot?: boolean
  mentionedBot?: boolean
  replyTo?: string | null
  raw?: unknown
  address: TriggerAddress
  disposition?: TriggerDisposition
  targetBotId?: string | null
  sourceBotId?: string | null
  handoffChainId?: string | null
  handoffHop?: number
  createdAt?: Date
}

/** Insert a trigger, returning false when (provider, external_id) already exists. */
export async function insertTrigger(db: Database, input: NewTrigger): Promise<boolean> {
  const rows = await db
    .insert(triggers)
    .values({
      id: input.id,
      projectId: input.projectId,
      channelId: input.channelId,
      roomId: input.roomId ?? null,
      provider: input.provider,
      externalId: input.externalId,
      kind: input.kind ?? 'message',
      messageId: input.messageId ?? null,
      threadKey: input.threadKey,
      actorUserId: input.actorUserId ?? null,
      actorExternalId: input.actorExternalId ?? null,
      actorName: input.actorName ?? null,
      text: input.text,
      isBot: input.isBot ?? false,
      mentionedBot: input.mentionedBot ?? false,
      replyTo: input.replyTo ?? null,
      raw: input.raw ?? null,
      address: input.address,
      disposition: input.disposition ?? 'pending',
      targetBotId: input.targetBotId ?? null,
      sourceBotId: input.sourceBotId ?? null,
      handoffChainId: input.handoffChainId ?? null,
      handoffHop: input.handoffHop ?? 0,
      createdAt: input.createdAt ?? new Date(),
    })
    .onConflictDoNothing({ target: [triggers.provider, triggers.externalId] })
    .returning({ id: triggers.id })
  return rows.length > 0
}

export async function getTrigger(db: Database, id: string): Promise<TriggerRow | undefined> {
  const [row] = await db.select().from(triggers).where(eq(triggers.id, id))
  return row
}

export interface TriggerScope {
  projectId: string
  channelId: string | null
  threadKey: string
}

export async function listPendingTriggers(
  db: Database,
  scope: TriggerScope,
  limit: number,
): Promise<TriggerRow[]> {
  return db
    .select()
    .from(triggers)
    .where(
      and(
        eq(triggers.projectId, scope.projectId),
        scope.channelId === null ? undefined : eq(triggers.channelId, scope.channelId),
        eq(triggers.threadKey, scope.threadKey),
        eq(triggers.disposition, 'pending'),
      ),
    )
    .orderBy(asc(triggers.createdAt))
    .limit(limit)
}

export async function listRecentTriggers(
  db: Database,
  scope: TriggerScope,
  limit: number,
): Promise<TriggerRow[]> {
  return db
    .select()
    .from(triggers)
    .where(
      and(
        eq(triggers.projectId, scope.projectId),
        scope.channelId === null ? undefined : eq(triggers.channelId, scope.channelId),
        eq(triggers.threadKey, scope.threadKey),
      ),
    )
    .orderBy(desc(triggers.createdAt))
    .limit(limit)
}

export async function setTriggerDisposition(
  db: Database,
  id: string,
  disposition: TriggerDisposition,
): Promise<void> {
  await db.update(triggers).set({ disposition }).where(eq(triggers.id, id))
}

export async function setTriggerEvaluation(
  db: Database,
  id: string,
  evaluationId: string | null,
): Promise<void> {
  await db.update(triggers).set({ evaluationId }).where(eq(triggers.id, id))
}
