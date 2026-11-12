import type { ChannelProvider } from './status.js'

/** A message after an IM adapter normalized provider-specific fields. */
export interface InboundMessage {
  provider: ChannelProvider
  providerMessageId: string
  externalChatId: string
  /** Provider thread key; for a new top-level message the message id itself. */
  threadKey: string
  sender: {
    externalId: string
    name?: string
    isBot?: boolean
  }
  text: string
  /** True when the message @-mentions this deployment's bot. */
  mentionBot: boolean
  replyToMessageId?: string
  raw?: unknown
}

export interface InboundEvent {
  provider: ChannelProvider
  /** Provider-side dedupe id (Feishu event_id, WeCom MsgId, GitHub delivery id). */
  deliveryId: string
  eventType: string
  messages: InboundMessage[]
  raw?: unknown
}

/** Placeholders Feishu puts in the text for mentions, e.g. `@_user_1`. */
const MENTION_PLACEHOLDER = /@_user_\d+|@_all\b/g

export function stripMentions(text: string): string {
  return text.replace(MENTION_PLACEHOLDER, ' ').replace(/\s+/g, ' ').trim()
}

export function ticketTitle(text: string, max = 120): string {
  const cleaned = stripMentions(text).split('\n')[0]?.trim() ?? ''
  if (!cleaned) return '未命名需求'
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}

export function threadKeyFor(message: { threadKey?: string; providerMessageId: string; replyToMessageId?: string }): string {
  return message.threadKey || message.replyToMessageId || message.providerMessageId
}
