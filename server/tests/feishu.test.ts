import { describe, expect, it } from 'vitest'
import { FeishuAdapter } from '../src/im/feishu.js'
import { decryptFeishuPayload, encryptFeishuPayload, feishuSignature } from '../src/im/feishu-crypto.js'
import { AppError } from '../src/errors.js'

const ENCRYPT_KEY = 'test-encrypt-key-0123456789abcdef'

function makeAdapter(fetchImpl?: typeof fetch) {
  return new FeishuAdapter({
    verificationToken: 'verify-token',
    encryptKey: ENCRYPT_KEY,
    botOpenId: 'ou_bot',
    apiBase: 'https://open.feishu.cn',
    ...(fetchImpl ? { fetchImpl } : {}),
  })
}

function signed(input: { body: string; timestamp?: string; nonce?: string }) {
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000))
  const nonce = input.nonce ?? 'nonce-1'
  const signature = feishuSignature({ timestamp, nonce, encryptKey: ENCRYPT_KEY, rawBody: input.body })
  return { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': signature }
}

function messageEvent(overrides: { eventId?: string; messageId?: string; text?: string; rootId?: string; sender?: string; mention?: boolean } = {}) {
  return {
    schema: '2.0',
    header: {
      event_id: overrides.eventId ?? 'evt_1',
      event_type: 'im.message.receive_v1',
      token: 'verify-token',
      create_time: String(Date.now()),
    },
    event: {
      sender: { sender_id: { open_id: overrides.sender ?? 'ou_alice' }, sender_type: 'user' },
      message: {
        message_id: overrides.messageId ?? 'om_1',
        chat_id: 'oc_project',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: overrides.text ?? '@_user_1 请修复登录页' }),
        mentions:
          overrides.mention === false
            ? []
            : [{ key: '@_user_1', name: 'Superagent', id: { open_id: 'ou_bot' } }],
        ...(overrides.rootId ? { root_id: overrides.rootId, parent_id: overrides.rootId } : {}),
      },
    },
  }
}

describe('Feishu crypto', () => {
  it('round-trips AES-256-CBC payloads', () => {
    const encrypted = encryptFeishuPayload(ENCRYPT_KEY, '{"hello":"世界"}')
    expect(decryptFeishuPayload(ENCRYPT_KEY, encrypted)).toBe('{"hello":"世界"}')
  })
})

describe('Feishu adapter', () => {
  it('answers url_verification with the challenge', async () => {
    const adapter = makeAdapter()
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc', token: 'verify-token' })
    const result = await adapter.verifyAndParse({
      headers: signed({ body }),
      rawBody: Buffer.from(body),
      query: {},
    })
    expect(result.challenge).toBe('abc')
    expect(result.events).toHaveLength(0)
  })

  it('decrypts and normalizes an encrypted message event', async () => {
    const adapter = makeAdapter()
    const plain = JSON.stringify(messageEvent())
    const body = JSON.stringify({ encrypt: encryptFeishuPayload(ENCRYPT_KEY, plain) })
    const result = await adapter.verifyAndParse({
      headers: signed({ body }),
      rawBody: Buffer.from(body),
      query: {},
    })
    expect(result.events).toHaveLength(1)
    const event = result.events[0]!
    expect(event.deliveryId).toBe('evt_1')
    expect(event.messages[0]).toMatchObject({
      provider: 'feishu',
      providerMessageId: 'om_1',
      externalChatId: 'oc_project',
      mentionBot: true,
      threadKey: 'om_1',
    })
    expect(event.messages[0]?.sender.externalId).toBe('ou_alice')
    expect(event.messages[0]?.text).toContain('请修复登录页')
  })

  it('rejects a bad signature', async () => {
    const adapter = makeAdapter()
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc', token: 'verify-token' })
    const headers = { ...signed({ body }), 'x-lark-signature': 'deadbeef' }
    await expect(adapter.verifyAndParse({ headers, rawBody: Buffer.from(body), query: {} })).rejects.toBeInstanceOf(AppError)
  })

  it('sends text through the reply endpoint and caches the tenant token', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('tenant_access_token')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-1', expire: 7200 }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_out' } }), { status: 200 })
    }) as typeof fetch
    const adapter = makeAdapter(fetchImpl)
    // Accessing send requires app credentials, so construct a second adapter for sending.
    const sender = new FeishuAdapter({
      appId: 'cli_1',
      appSecret: 'secret',
      apiBase: 'https://open.feishu.cn',
      fetchImpl,
    })
    const result = await sender.send({ chatId: 'oc_project', text: 'hello', replyToMessageId: 'om_1' })
    expect(result.messageId).toBe('om_out')
    expect(calls[0]?.url).toContain('tenant_access_token')
    expect(calls[1]?.url).toContain('/im/v1/messages/om_1/reply')
  })
})
