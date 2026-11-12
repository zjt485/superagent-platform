import { XMLParser } from 'fast-xml-parser'
import { AppError } from '../errors.js'
import type { ImAdapter, ImWebhookInput, ImWebhookResult, SendMessageInput, SendMessageResult } from '../domain/im.js'
import type { InboundEvent } from '../domain/message.js'
import type { OAuthIdentity, OAuthProvider } from '../domain/oauth.js'
import { decryptWecom, verifyWecomSignature } from './wecom-crypto.js'

export interface WecomOptions {
  corpId?: string
  agentId?: string
  secret?: string
  token?: string
  encodingAesKey?: string
  apiBase: string
  botName: string
  fetchImpl?: typeof fetch
}

type Json = Record<string, unknown>

const asRecord = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {})
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}
const firstString = (value: unknown): string | undefined => {
  if (Array.isArray(value)) return asString(value[0])
  return asString(value)
}

const xmlParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true })

function parseXml(xml: string): Json {
  const parsed = asRecord(xmlParser.parse(xml))
  return asRecord(parsed.xml)
}

export class WecomAdapter implements ImAdapter, OAuthProvider {
  readonly provider = 'wecom' as const
  private readonly fetchImpl: typeof fetch
  private token: { value: string; expiresAt: number } | null = null

  constructor(private readonly options: WecomOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  async verifyAndParse(input: ImWebhookInput): Promise<ImWebhookResult> {
    const query = lowerHeaders(input.query)
    const signature = query.msg_signature
    const timestamp = query.timestamp
    const nonce = query.nonce
    const echo = query.echostr
    if (echo) {
      this.requireCrypto()
      if (!signature || !timestamp || !nonce) throw new AppError(401, 'unauthorized', 'missing WeCom signature parameters')
      if (!verifyWecomSignature({ token: this.options.token as string, timestamp, nonce, encrypt: echo, signature })) {
        throw new AppError(401, 'unauthorized', 'invalid WeCom signature')
      }
      const { message, corpId } = decryptWecom(this.options.encodingAesKey as string, echo)
      if (corpId !== this.options.corpId) throw new AppError(401, 'unauthorized', 'WeCom corp id mismatch')
      return { challenge: message, events: [], deliveryIds: [] }
    }

    const body = parseXml(input.rawBody.toString('utf8'))
    const encrypt = firstString(body.Encrypt)
    if (!encrypt) throw new AppError(400, 'bad_request', 'missing WeCom Encrypt payload')
    this.requireCrypto()
    if (!signature || !timestamp || !nonce) throw new AppError(401, 'unauthorized', 'missing WeCom signature parameters')
    if (!verifyWecomSignature({ token: this.options.token as string, timestamp, nonce, encrypt, signature })) {
      throw new AppError(401, 'unauthorized', 'invalid WeCom signature')
    }
    const { message, corpId } = decryptWecom(this.options.encodingAesKey as string, encrypt)
    if (corpId !== this.options.corpId) throw new AppError(401, 'unauthorized', 'WeCom corp id mismatch')

    const event = this.normalize(parseXml(message))
    return event ? { events: [event], deliveryIds: [event.deliveryId] } : { events: [], deliveryIds: [] }
  }

  private normalize(body: Json): InboundEvent | null {
    const messageType = firstString(body.MsgType) ?? ''
    const messageId = firstString(body.MsgId)
    const from = firstString(body.FromUserName)
    const chatId = firstString(body.ChatId) ?? from
    if (messageType === 'event' || !messageId || !from || !chatId) return null
    const content = firstString(body.Content) ?? (messageType === 'text' ? '' : `[${messageType}]`)
    const botName = this.options.botName
    const mentionBot = content.includes(`@${botName}`) || content.includes(`＠${botName}`)
    // WeCom has no mention metadata for app messages: remove the textual bot
    // mention so `/status` and ticket titles parse the same way as Feishu.
    const cleaned = mentionBot
      ? content.replace(new RegExp(`[@＠]?${escapeRegExp(botName)}`, 'g'), ' ').replace(/\s+/g, ' ').trim()
      : content
    return {
      provider: 'wecom',
      deliveryId: messageId,
      eventType: `message.${messageType}`,
      messages: [
        {
          provider: 'wecom',
          providerMessageId: messageId,
          externalChatId: chatId,
          // WeCom app messages carry no thread id; each message is its own thread.
          threadKey: messageId,
          sender: { externalId: from, name: from, isBot: false },
          text: cleaned,
          mentionBot,
          raw: body,
        },
      ],
      raw: body,
    }
  }

  private requireCrypto(): void {
    if (!this.options.corpId || !this.options.token || !this.options.encodingAesKey) {
      throw new AppError(503, 'internal', 'WeCom callback credentials are not configured')
    }
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const webhookUrl = asString(asRecord(input.channelConfig).webhookUrl)
    const text = input.card ? [input.card.title, input.card.body, input.card.url].filter(Boolean).join('\n') : input.text
    if (webhookUrl) {
      const response = await this.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      })
      const payload = (await response.json().catch(() => ({}))) as Json
      if (!response.ok || Number(payload.errcode ?? 0) !== 0) {
        throw new AppError(502, 'internal', `WeCom robot webhook failed: ${asString(payload.errmsg) ?? response.status}`)
      }
      return { messageId: asString(payload.msgid) }
    }
    if (!this.options.corpId || !this.options.secret || !this.options.agentId) {
      throw new AppError(500, 'internal', 'WeCom app credentials are not configured')
    }
    const token = await this.accessToken()
    const payload = await this.request<Json>(`/cgi-bin/appchat/send?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      body: JSON.stringify({ chatid: input.chatId, msgtype: 'text', text: { content: text } }),
    })
    if (Number(payload.errcode ?? 0) !== 0) {
      throw new AppError(502, 'internal', `WeCom appchat/send failed: ${asString(payload.errmsg) ?? 'unknown error'}`)
    }
    return { messageId: asString(payload.msgid) }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value
    const query = new URLSearchParams({
      corpid: this.options.corpId ?? '',
      corpsecret: this.options.secret ?? '',
    })
    const response = await this.fetchImpl(`${this.options.apiBase}/cgi-bin/gettoken?${query.toString()}`)
    const payload = (await response.json().catch(() => ({}))) as Json
    const token = asString(payload.access_token)
    if (!response.ok || !token) throw new AppError(502, 'internal', `WeCom gettoken failed: ${asString(payload.errmsg) ?? response.status}`)
    this.token = { value: token, expiresAt: Date.now() + Number(payload.expires_in ?? 7200) * 1000 }
    return token
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.options.apiBase}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    })
    if (!response.ok) throw new AppError(502, 'internal', `WeCom API ${path} failed with HTTP ${response.status}`)
    return (await response.json().catch(() => ({}))) as T
  }

  /**
   * Creates an app-managed group chat. This is required for real scan-to-join:
   * WeCom only lets the app add members to chats it created itself.
   */
  async createChat(input: { name: string; ownerUserId: string; userIds: string[] }): Promise<{ chatId: string }> {
    if (!this.options.corpId || !this.options.secret) {
      throw new AppError(500, 'internal', 'WeCom app credentials are not configured')
    }
    const token = await this.accessToken()
    const userlist = [...new Set([input.ownerUserId, ...input.userIds])].filter(Boolean)
    const payload = await this.request<Json>(`/cgi-bin/appchat/create?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      body: JSON.stringify({
        name: input.name.slice(0, 64),
        owner: input.ownerUserId,
        userlist,
      }),
    })
    if (Number(payload.errcode ?? 0) !== 0) {
      throw new AppError(502, 'internal', `WeCom appchat/create failed: ${asString(payload.errmsg) ?? 'unknown error'}`)
    }
    const chatId = asString(payload.chatid)
    if (!chatId) throw new AppError(502, 'internal', 'WeCom appchat/create did not return a chatid')
    return { chatId }
  }

  /**
   * Adds members to an app-managed group chat (`appchat`). Arbitrary existing
   * WeCom groups cannot be modified through the API; the update call fails and
   * the caller falls back to the group QR / invite link.
   */
  async addMembers(input: { chatId: string; externalUserIds: string[] }): Promise<{ added: string[] }> {
    if (input.externalUserIds.length === 0) return { added: [] }
    if (!this.options.corpId || !this.options.secret) {
      throw new AppError(500, 'internal', 'WeCom app credentials are not configured')
    }
    const token = await this.accessToken()
    const info = await this.request<Json>(
      `/cgi-bin/appchat/get?access_token=${encodeURIComponent(token)}&chatid=${encodeURIComponent(input.chatId)}`,
      { method: 'GET' },
    )
    if (Number(info.errcode ?? 0) !== 0) {
      throw new AppError(502, 'internal', `WeCom appchat/get failed: ${asString(info.errmsg) ?? 'unknown error'}`)
    }
    const chat = asRecord(info.chat_info)
    const existing = asArray(chat.userlist).map((value) => String(value))
    const merged = [...new Set([...existing, ...input.externalUserIds])]
    const body: Json = { chatid: input.chatId, userlist: merged }
    if (typeof chat.name === 'string') body.name = chat.name
    if (typeof chat.owner === 'string') body.owner = chat.owner
    const updated = await this.request<Json>(`/cgi-bin/appchat/update?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (Number(updated.errcode ?? 0) !== 0) {
      throw new AppError(502, 'internal', `WeCom appchat/update failed: ${asString(updated.errmsg) ?? 'unknown error'}`)
    }
    return { added: input.externalUserIds.filter((id) => !existing.includes(id)) }
  }

  authorizeUrl(input: { state: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      appid: this.options.corpId ?? '',
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: 'snsapi_base',
      state: input.state,
    })
    return `https://open.weixin.qq.com/connect/oauth2/authorize?${params.toString()}#wechat_redirect`
  }

  async exchange(input: { code: string; redirectUri: string }): Promise<OAuthIdentity> {
    const token = await this.accessToken()
    const userResponse = await this.fetchImpl(
      `${this.options.apiBase}/cgi-bin/auth/getuserinfo?access_token=${encodeURIComponent(token)}&code=${encodeURIComponent(input.code)}`,
    )
    const userPayload = (await userResponse.json().catch(() => ({}))) as Json
    const userId = asString(userPayload.UserId) ?? asString(userPayload.userid)
    if (!userId) throw new AppError(401, 'unauthorized', 'WeCom OAuth did not return a user id')
    const detailResponse = await this.fetchImpl(
      `${this.options.apiBase}/cgi-bin/user/get?access_token=${encodeURIComponent(token)}&userid=${encodeURIComponent(userId)}`,
    )
    const detail = (await detailResponse.json().catch(() => ({}))) as Json
    return {
      externalId: userId,
      name: asString(detail.name) ?? userId,
      ...(asString(detail.avatar) ? { avatar: asString(detail.avatar) } : {}),
      ...(asString(detail.email) ? { email: asString(detail.email) } : {}),
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function lowerHeaders(headers: ImWebhookInput['query']): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const single = Array.isArray(value) ? value[0] : value
    if (typeof single === 'string') result[key.toLowerCase()] = single
  }
  return result
}
