import type { MessageCard } from './im.js'

/** A notification queued in the outbox and delivered by the sender loop. */
export interface OutboxMessage {
  /** Plain text sent to the IM chat (Feishu `text` message). */
  text: string
  /** Reply inside this provider message's thread when supported. */
  replyToMessageId?: string
  /** Optional richer card payload for providers that support it. */
  card?: MessageCard
}

export interface OutboxRecord {
  id: string
  projectId: string
  channelId: string | null
  kind: string
  message: OutboxMessage
  attempts: number
}
