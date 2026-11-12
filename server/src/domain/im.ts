import type { InboundEvent } from './message.js'
import type { ChannelProvider } from './status.js'

export interface SendMessageInput {
  chatId: string
  text: string
  replyToMessageId?: string
  card?: { title: string; body: string; url?: string }
  /** Channel-specific settings, e.g. a WeCom group-robot webhook URL. */
  channelConfig?: Record<string, unknown>
}

export interface SendMessageResult {
  messageId?: string
  simulated?: boolean
}

export interface ImWebhookInput {
  headers: Record<string, string | string[] | undefined>
  rawBody: Buffer
  query: Record<string, string | string[] | undefined>
}

export interface ImWebhookResult {
  /** URL verification challenge to echo back verbatim. */
  challenge?: string
  /** Normalized events; empty for verification calls. */
  events: InboundEvent[]
  /** Provider delivery id used for webhook idempotency. */
  deliveryIds: string[]
}

/**
 * One interface for every IM platform (FR-05, §7.2). Adapters own signature
 * verification, decryption, payload normalization and message sending.
 */
export interface ImAdapter {
  provider: ChannelProvider
  verifyAndParse(input: ImWebhookInput): Promise<ImWebhookResult>
  send(input: SendMessageInput): Promise<SendMessageResult>
  /**
   * Optional: add people to an existing chat after they accept a project
   * invitation (§4.2 step 5). Platforms without this capability fall back to
   * showing a group QR code / invite link.
   */
  addMembers?(input: { chatId: string; externalUserIds: string[] }): Promise<{ added: string[] }>
}

export type ImRegistry = Partial<Record<ChannelProvider, ImAdapter>>
