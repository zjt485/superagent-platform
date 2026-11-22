import type { Database } from '../db/client.js'
import { newId } from '../domain/ids.js'
import type { TriggerAddress } from './domain/types.js'
import { insertTrigger, setTriggerDisposition } from './store/triggers.js'
import { markThreadPending, touchThread } from './store/threads.js'

export interface CoreInbound {
  projectId: string
  channelId: string | null
  provider: string
  externalId: string
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
  at: Date
}

export type CoreIntakeAction = 'ignored' | 'duplicate' | 'command' | 'queued'

export interface CoreIntakeResult {
  action: CoreIntakeAction
  triggerId?: string
}

/** Store an inbound message for the core Router, preserving intake authorization. */
export async function receiveCoreTrigger(db: Database, input: CoreInbound): Promise<CoreIntakeResult> {
  if (input.authorized === false || input.isBot === true) return { action: 'ignored' }
  const text = input.text.trim()
  if (text.length === 0) return { action: 'ignored' }

  const triggerId = newId()
  const inserted = await insertTrigger(db, {
    id: triggerId,
    projectId: input.projectId,
    channelId: input.channelId,
    provider: input.provider,
    externalId: input.externalId,
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
