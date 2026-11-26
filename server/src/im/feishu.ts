import { AppError } from '../errors.js'
import { constantTimeEqual } from '../security/tokens.js'
import type { ImAdapter, ImWebhookInput, ImWebhookResult, MessageCard, SendMessageInput, SendMessageResult } from '../domain/im.js'
import type { InboundEvent, InboundMessage } from '../domain/message.js'
import type { OAuthIdentity, OAuthProvider } from '../domain/oauth.js'
import { decryptFeishuPayload, verifyFeishuSignature } from './feishu-crypto.js'

export interface FeishuOptions {
  appId?: string
  appSecret?: string
  verificationToken?: string
  encryptKey?: string
  botOpenId?: string
  apiBase: string
  fetchImpl?: typeof fetch
}

type Json = Record<string, unknown>

const asRecord = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {})
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

export function buildFeishuInteractiveCard(card: MessageCard): Json {
  const template =
    card.status === 'approved'
      ? 'green'
      : card.status === 'rejected'
        ? 'red'
        : card.riskLevel === 'high'
          ? 'orange'
          : 'blue'
  const elements: Json[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: card.body.slice(0, 4000) },
    },
  ]

  const actions: Json[] = []
  if (card.approvalId && card.projectId && (!card.status || card.status === 'pending')) {
    actions.push(
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '批准执行' },
        type: 'primary',
        value: { action: 'approval', decision: 'approved', projectId: card.projectId, approvalId: card.approvalId },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '拒绝' },
        type: 'danger',
        value: { action: 'approval', decision: 'rejected', projectId: card.projectId, approvalId: card.approvalId },
      },
    )
  }
  if (card.url) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '在控制台查看' },
      type: 'default',
      url: card.url,
    })
  }
  if (actions.length > 0) {
    elements.push({ tag: 'action', actions })
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: card.title.slice(0, 120) },
    },
    elements,
  }
}
interface TokenCache {
  value: string
  expiresAt: number
}

export class FeishuAdapter implements ImAdapter, OAuthProvider {
  readonly provider = 'feishu' as const
  private readonly fetchImpl: typeof fetch
  private token: TokenCache | null = null
  private resolvedBotOpenId: string | undefined

  constructor(private readonly options: FeishuOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.resolvedBotOpenId = options.botOpenId
  }

  // -------------------------------------------------------------------------
  // Webhook verification and normalization
  // -------------------------------------------------------------------------

  async verifyAndParse(input: ImWebhookInput): Promise<ImWebhookResult> {
    const rawBody = input.rawBody.toString('utf8')
    const headers = lowerHeaders(input.headers)
    const encryptKey = this.options.encryptKey
    const timestamp = headers['x-lark-request-timestamp']
    const nonce = headers['x-lark-request-nonce']
    const signature = headers['x-lark-signature']
    const signed = Boolean(timestamp && nonce && signature)

    if (signed) {
      if (!encryptKey) throw new AppError(401, 'unauthorized', 'unexpected Feishu signature headers')
      if (Math.abs(Date.now() - Number(timestamp) * 1000) > 5 * 60_000) {
        throw new AppError(401, 'unauthorized', 'Feishu callback timestamp is outside the allowed window')
      }
      const valid = verifyFeishuSignature({ timestamp: timestamp as string, nonce: nonce as string, encryptKey, rawBody, signature: signature as string })
      if (!valid) throw new AppError(401, 'unauthorized', 'invalid Feishu signature')
    }

    let payload: Json
    try {
      payload = JSON.parse(rawBody) as Json
    } catch {
      throw new AppError(400, 'bad_request', 'invalid JSON body')
    }

    if (typeof payload.encrypt === 'string') {
      if (!encryptKey) throw new AppError(400, 'bad_request', 'encrypted Feishu payload without configured encrypt key')
      // Encrypted callbacks must always be signed; setup challenges may be
      // sent without a signature but still need a valid verification token.
      if (!signed) throw new AppError(401, 'unauthorized', 'missing Feishu signature headers')
      const plain = decryptFeishuPayload(encryptKey, payload.encrypt)
      payload = JSON.parse(plain) as Json
    } else if (payload.type !== 'url_verification' && encryptKey && !signed) {
      throw new AppError(401, 'unauthorized', 'missing Feishu signature headers')
    }

    const token = asString(payload.token) ?? asString(asRecord(payload.header).token)
    if (this.options.verificationToken) {
      if (!token || !constantTimeEqual(token, this.options.verificationToken)) {
        throw new AppError(401, 'unauthorized', 'invalid Feishu verification token')
      }
    }

    if (payload.type === 'url_verification') {
      const challenge = asString(payload.challenge)
      if (!challenge) throw new AppError(400, 'bad_request', 'missing Feishu challenge')
      return { challenge, events: [], deliveryIds: [] }
    }

    const header = asRecord(payload.header)
    const eventType = asString(header.event_type) ?? ''
    const eventId = asString(header.event_id) ?? ''
    if (eventType !== 'im.message.receive_v1') {
      return { events: [], deliveryIds: eventId ? [eventId] : [] }
    }
    const message = await this.normalizeMessage(asRecord(payload.event), eventType, eventId)
    if (!message) return { events: [], deliveryIds: eventId ? [eventId] : [] }
    return { events: [message], deliveryIds: [eventId || message.messages[0]?.providerMessageId || ''] }
  }

  private async normalizeMessage(event: Json, eventType: string, eventId: string): Promise<InboundEvent | null> {
    const rawMessage = asRecord(event.message)
    const sender = asRecord(event.sender)
    const senderId = asRecord(sender.sender_id)
    const messageId = asString(rawMessage.message_id)
    const chatId = asString(rawMessage.chat_id)
    if (!messageId || !chatId) return null

    const opens = asString(senderId.open_id) ?? asString(senderId.user_id) ?? asString(senderId.union_id)
    if (!opens) return null

    const mentions = asArray(rawMessage.mentions).map(asRecord)
    const botOpenId = await this.botOpenId().catch(() => undefined)
    const mentionBot = botOpenId
      ? mentions.some((mention) => asString(asRecord(mention.id).open_id) === botOpenId)
      : mentions.length > 0

    const messageType = asString(rawMessage.message_type) ?? 'text'
    const content = parseContent(messageType, asString(rawMessage.content) ?? '{}')
    const threadKey = asString(rawMessage.thread_id) ?? asString(rawMessage.root_id) ?? messageId
    const replyTo = asString(rawMessage.parent_id) ?? asString(rawMessage.root_id)

    const normalized: InboundMessage = {
      provider: 'feishu',
      providerMessageId: messageId,
      externalChatId: chatId,
      threadKey,
      sender: {
        externalId: opens,
        name: asString(asRecord(sender).sender_name),
        isBot: asString(sender.sender_type) === 'app' || asString(sender.sender_type) === 'bot',
      },
      text: content.text,
      mentionBot,
      ...(replyTo ? { replyToMessageId: replyTo } : {}),
      raw: event,
    }
    return { provider: 'feishu', deliveryId: eventId || messageId, eventType, messages: [normalized], raw: event }
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const token = await this.tenantToken()
    const body: Json = input.card
      ? { msg_type: 'interactive', content: JSON.stringify(buildFeishuInteractiveCard(input.card)) }
      : { msg_type: 'text', content: JSON.stringify({ text: input.text }) }
    const path = input.replyToMessageId
      ? `/open-apis/im/v1/messages/${encodeURIComponent(input.replyToMessageId)}/reply`
      : '/open-apis/im/v1/messages?receive_id_type=chat_id'
    if (input.replyToMessageId) body.reply_in_thread = true
    else body.receive_id = input.chatId
    const response = await this.request<Json>(path, { method: 'POST', body: JSON.stringify(body) }, token)
    const data = asRecord(response.data)
    return { messageId: asString(data.message_id) }
  }

  /** Update an existing interactive card in place (e.g. after approval is decided). */
  async updateCard(messageId: string, card: MessageCard): Promise<void> {
    const token = await this.tenantToken()
    await this.request<Json>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ content: JSON.stringify(buildFeishuInteractiveCard(card)) }),
      },
      token,
    )
  }

  /**
   * Adds project members to the bound Feishu chat. Requires the app to be a
   * group admin and to hold `im:chat.members:write_only`.
   */
  async addMembers(input: { chatId: string; externalUserIds: string[] }): Promise<{ added: string[] }> {
    if (input.externalUserIds.length === 0) return { added: [] }
    const token = await this.tenantToken()
    await this.request<Json>(
      `/open-apis/im/v1/chats/${encodeURIComponent(input.chatId)}/members?member_id_type=open_id`,
      {
        method: 'POST',
        body: JSON.stringify({ id_list: input.externalUserIds }),
      },
      token,
    )
    return { added: input.externalUserIds }
  }

  private async tenantToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value
    if (!this.options.appId || !this.options.appSecret) {
      throw new AppError(500, 'internal', 'Feishu app credentials are not configured')
    }
    const response = await this.request<Json>(
      '/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        body: JSON.stringify({ app_id: this.options.appId, app_secret: this.options.appSecret }),
      },
      undefined,
      true,
    )
    const token = asString(response.tenant_access_token)
    if (!token) throw new AppError(502, 'internal', 'Feishu did not return a tenant access token')
    const expires = Number(response.expire ?? 7200)
    this.token = { value: token, expiresAt: Date.now() + expires * 1000 }
    return token
  }

  private async botOpenId(): Promise<string | undefined> {
    if (this.resolvedBotOpenId) return this.resolvedBotOpenId
    if (!this.options.appId || !this.options.appSecret) return undefined
    const token = await this.tenantToken()
    const response = await this.request<Json>('/open-apis/bot/v3/info', { method: 'GET' }, token)
    const bot = asRecord(asRecord(response.data).bot)
    this.resolvedBotOpenId = asString(bot.open_id)
    return this.resolvedBotOpenId
  }

  private async request<T>(path: string, init: RequestInit, token?: string, allowErrorCode = false): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    }
    const response = await this.fetchImpl(`${this.options.apiBase}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } })
    if (!response.ok) {
      throw new AppError(502, 'internal', `Feishu API ${path} failed with HTTP ${response.status}`)
    }
    const payload = (await response.json().catch(() => ({}))) as Json
    const code = Number(payload.code ?? 0)
    if (code !== 0 && !allowErrorCode) {
      throw new AppError(502, 'internal', `Feishu API ${path} failed: ${asString(payload.msg) ?? code}`)
    }
    return payload as T
  }

  // -------------------------------------------------------------------------
  // OAuth (console login)
  // -------------------------------------------------------------------------

  authorizeUrl(input: { state: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      app_id: this.options.appId ?? '',
      redirect_uri: input.redirectUri,
      state: input.state,
      response_type: 'code',
    })
    return `${this.options.apiBase}/open-apis/authen/v1/authorize?${params.toString()}`
  }

  async exchange(input: { code: string; redirectUri: string }): Promise<OAuthIdentity> {
    const tokenResponse = await this.request<Json>(
      '/open-apis/authen/v2/oauth/token',
      {
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: this.options.appId,
          client_secret: this.options.appSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
        }),
      },
      undefined,
      true,
    )
    if (Number(tokenResponse.code ?? 0) !== 0 || !asString(tokenResponse.access_token)) {
      throw new AppError(401, 'unauthorized', `Feishu OAuth exchange failed: ${asString(tokenResponse.error_description) ?? asString(tokenResponse.msg) ?? 'unknown error'}`)
    }
    const accessToken = asString(tokenResponse.access_token) as string
    const response = await this.fetchImpl(`${this.options.apiBase}/open-apis/authen/v1/user_info`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) throw new AppError(502, 'internal', `Feishu user_info failed with HTTP ${response.status}`)
    const payload = (await response.json().catch(() => ({}))) as Json
    if (Number(payload.code ?? 0) !== 0) throw new AppError(502, 'internal', 'Feishu user_info returned an error')
    const data = asRecord(payload.data)
    const openId = asString(data.open_id) ?? asString(data.user_id)
    if (!openId) throw new AppError(502, 'internal', 'Feishu user_info has no open_id')
    return {
      externalId: openId,
      name: asString(data.name) ?? '飞书用户',
      ...(asString(data.avatar_url) ? { avatar: asString(data.avatar_url) } : {}),
      ...(asString(data.email) ? { email: asString(data.email) } : {}),
    }
  }
}

function lowerHeaders(headers: ImWebhookInput['headers']): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const single = Array.isArray(value) ? value[0] : value
    if (typeof single === 'string') result[key.toLowerCase()] = single
  }
  return result
}

export function parseContent(messageType: string, raw: string): { text: string } {
  try {
    const parsed = asRecord(JSON.parse(raw))
    if (messageType === 'text') return { text: asString(parsed.text) ?? '' }
    if (messageType === 'post') {
      const post = asRecord(parsed.post)
      const locale = asRecord(post.zh_cn ?? post.en_us ?? Object.values(post)[0])
      const title = asString(locale.title) ?? ''
      const paragraphs = asArray(locale.content)
        .map((paragraph) =>
          asArray(paragraph)
            .map((element) => {
              const item = asRecord(element)
              if (item.tag === 'at') return `@${asString(item.user_name) ?? 'user'}`
              return asString(item.text) ?? ''
            })
            .join(''),
        )
        .filter(Boolean)
      return { text: [title, ...paragraphs].filter(Boolean).join('\n') }
    }
    return { text: `[${messageType}]` }
  } catch {
    return { text: '' }
  }
}
