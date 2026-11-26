import type { Database } from '../db/client.js'
import { newId } from '../domain/ids.js'
import type { TriggerAddress } from './domain/types.js'
import { insertTrigger, setTriggerDisposition } from './store/triggers.js'
import { markThreadPending, touchThread } from './store/threads.js'

export interface CoreInbound {
  projectId: string
  channelId: string | null
  roomId?: string | null
  provider: string
  externalId: string
  kind?: 'message' | 'command' | 'ci' | 'pr_comment' | 'pr_merge' | 'pr_close' | 'resume' | 'handoff' | 'routine'
  threadKey: string
  actorUserId?: string | null
  actorExternalId?: string | null
  actorName?: string | null
  text: string
  address: TriggerAddress
  isBot?: boolean
  mentionedBot?: boolean
  replyTo?: string | null
  raw?: unknown
  authorized?: boolean
  targetBotId?: string | null
  sourceBotId?: string | null
  handoffChainId?: string | null
  handoffHop?: number
  at: Date
}

export type CoreIntakeAction = 'ignored' | 'duplicate' | 'command' | 'queued'

export interface CoreIntakeResult {
  action: CoreIntakeAction
  triggerId?: string
}

/** Store an inbound message for the core Router, preserving intake authorization. */
export async function receiveCoreTrigger(db: Database, input: CoreInbound): Promise<CoreIntakeResult> {
  const isInternalBotEvent = input.kind === 'handoff' || input.kind === 'routine'
  if (input.authorized === false || (input.isBot === true && !isInternalBotEvent)) return { action: 'ignored' }
  const text = input.text.trim()
  if (text.length === 0) return { action: 'ignored' }

  const triggerId = newId()
  const inserted = await insertTrigger(db, {
    id: triggerId,
    projectId: input.projectId,
    channelId: input.channelId,
    roomId: input.roomId ?? null,
    provider: input.provider,
    externalId: input.externalId,
    kind: input.kind ?? 'message',
    threadKey: input.threadKey,
    actorUserId: input.actorUserId ?? null,
    actorExternalId: input.actorExternalId ?? null,
    actorName: input.actorName ?? null,
    text,
    isBot: input.isBot ?? false,
    mentionedBot: input.mentionedBot ?? false,
    replyTo: input.replyTo ?? null,
    raw: input.raw ?? null,
    address: input.address,
    targetBotId: input.targetBotId ?? null,
    sourceBotId: input.sourceBotId ?? null,
    handoffChainId: input.handoffChainId ?? null,
    handoffHop: input.handoffHop ?? 0,
    createdAt: input.at,
  })
  if (!inserted) return { action: 'duplicate' }

  await touchThread(db, {
    projectId: input.projectId,
    channelId: input.channelId,
    threadKey: input.threadKey,
    at: input.at,
  })

  if (text.startsWith('/')) {
    await setTriggerDisposition(db, triggerId, 'command')
    return { action: 'command', triggerId }
  }

  await markThreadPending(
    db,
    { projectId: input.projectId, channelId: input.channelId, threadKey: input.threadKey },
    input.at,
  )
  return { action: 'queued', triggerId }
}
