import AiBot, { generateReqId, type MixedMessage, type TextMessage, type VoiceMessage, type WsFrame } from '@wecom/aibot-node-sdk'
import type { CoreContext } from '../core/operations.js'
import type { InboundEvent } from '../domain/message.js'
import { ingestInboundEvent } from '../services/intake.js'
import { hasWecomBot } from '../config.js'

export interface WecomBotHandle {
  sender: {
    provider: 'wecom'
    send(input: { chatId: string; text: string }): Promise<{ messageId?: string }>
  }
  stop(): Promise<void>
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function textOf(frame: WsFrame): string {
  const body = frame.body as TextMessage | MixedMessage | VoiceMessage | undefined
  if (!body) return ''
  if (body.msgtype === 'text') return body.text?.content ?? ''
  if (body.msgtype === 'voice') return body.voice?.content ?? ''
  if (body.msgtype === 'mixed') {
    return (body.mixed?.msg_item ?? [])
      .map((item) => (item.msgtype === 'text' ? item.text?.content ?? '' : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export function wecomBotTargetId(chatId: string): string {
  return chatId.startsWith('p2p:') ? chatId.slice(4) : chatId
}

export function botEventFromFrame(frame: WsFrame, botName: string): InboundEvent | null {
  const body = frame.body as TextMessage | MixedMessage | VoiceMessage | undefined
  const rawText = textOf(frame).trim()
  const content = botName
    ? rawText.replace(new RegExp(`[@＠]?${escapeRegExp(botName)}`, 'g'), ' ').replace(/\s+/g, ' ').trim()
    : rawText
  if (!body?.msgid || !content) return null
  const chatId = body.chatid ?? `p2p:${body.from.userid}`
  return {
    provider: 'wecom',
    deliveryId: body.msgid,
    eventType: 'aibot_msg_callback',
    messages: [
      {
        provider: 'wecom',
        providerMessageId: body.msgid,
        externalChatId: chatId,
        threadKey: chatId,
        sender: { externalId: body.from.userid, isBot: false },
        text: content,
        mentionBot: true,
        raw: body,
      },
    ],
    raw: body,
  }
}

/**
 * WeCom 智能机器人 long connection. Self-built appchat groups can only send;
 * this is the official receive path for group @ mentions. The bot must be
 * added to the group once by its owner (WeCom has no API to do that).
 */
export function startWecomBot(ctx: CoreContext): WecomBotHandle | null {
  if (!hasWecomBot(ctx.config)) return null

  const client = new AiBot.WSClient({
    botId: ctx.config.WECOM_BOT_ID as string,
    secret: ctx.config.WECOM_BOT_SECRET as string,
    ...(ctx.config.WECOM_BOT_WS_URL ? { wsUrl: ctx.config.WECOM_BOT_WS_URL } : {}),
    maxReconnectAttempts: -1,
    logger: {
      debug: (message, ...args) => ctx.log.debug({ args }, message),
      info: (message, ...args) => ctx.log.info({ args }, message),
      warn: (message, ...args) => ctx.log.warn({ args }, message),
      error: (message, ...args) => ctx.log.error({ args }, message),
    },
  })

  client.on('authenticated', () => ctx.log.info('wecom smart robot authenticated'))
  client.on('disconnected', (reason) => ctx.log.warn({ reason }, 'wecom smart robot disconnected'))
  client.on('error', (error) => ctx.log.error({ err: error }, 'wecom smart robot error'))

  const handle = (frame: WsFrame): void => {
    void (async () => {
      const event = botEventFromFrame(frame, ctx.config.WECOM_BOT_NAME)
      if (!event) return
      const results = await ingestInboundEvent(ctx, event)
      const first = event.messages[0]
      ctx.log.info(
        {
          msgId: event.deliveryId,
          chatId: first?.externalChatId,
          senderId: first?.sender.externalId,
          text: first?.text.slice(0, 120),
          results,
        },
        'wecom bot message ingested',
      )
    })().catch((error) => ctx.log.error({ err: error }, 'wecom bot message handling failed'))
  }

  client.on('message.text', handle)
  client.on('message.mixed', handle)
  client.on('message.voice', handle)
  client.connect()

  return {
    sender: {
      provider: 'wecom',
      async send(input) {
        const targetId = wecomBotTargetId(input.chatId)
        await client.sendMessage(targetId, {
          msgtype: 'markdown',
          markdown: { content: input.text.slice(0, 4096) },
        })
        return { messageId: generateReqId('superagent') }
      },
    },
    async stop() {
      client.disconnect()
    },
  }
}
