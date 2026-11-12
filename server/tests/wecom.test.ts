import { describe, expect, it } from 'vitest'
import { WecomAdapter } from '../src/im/wecom.js'
import { decryptWecom, encryptWecom, wecomSignature } from '../src/im/wecom-crypto.js'

const CORP_ID = 'ww_test_corp'
const TOKEN = 'test-wecom-token'
const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'

function makeAdapter(fetchImpl?: typeof fetch) {
  return new WecomAdapter({
    corpId: CORP_ID,
    agentId: '1000002',
    secret: 'corp-secret',
    token: TOKEN,
    encodingAesKey: AES_KEY,
    apiBase: 'https://qyapi.weixin.qq.com',
    botName: 'Superagent',
    ...(fetchImpl ? { fetchImpl } : {}),
  })
}

const timestamp = '1700000000'
const nonce = 'nonce-1'

describe('WeCom crypto', () => {
  it('round-trips payloads with the 32-byte padding scheme', () => {
    const encrypted = encryptWecom(AES_KEY, 'hello', CORP_ID)
    const result = decryptWecom(AES_KEY, encrypted)
    expect(result.message).toBe('hello')
    expect(result.corpId).toBe(CORP_ID)
  })

  it('verifies signatures over sorted inputs', () => {
    const signature = wecomSignature({ token: TOKEN, timestamp, nonce, encrypt: 'abc' })
    expect(signature).toHaveLength(40)
  })
})

describe('WeCom adapter', () => {
  it('answers URL verification with the decrypted echostr', async () => {
    const adapter = makeAdapter()
    const echo = encryptWecom(AES_KEY, 'verify-ok', CORP_ID)
    const signature = wecomSignature({ token: TOKEN, timestamp, nonce, encrypt: echo })
    const result = await adapter.verifyAndParse({
      headers: {},
      rawBody: Buffer.alloc(0),
      query: { msg_signature: signature, timestamp, nonce, echostr: echo },
    })
    expect(result.challenge).toBe('verify-ok')
  })

  it('decrypts an encrypted group message', async () => {
    const adapter = makeAdapter()
    const inner = `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[@Superagent 修复构建]]></Content><MsgId>1234567890</MsgId><AgentID>1000002</AgentID><ChatId>oc_group</ChatId></xml>`
    const encrypted = encryptWecom(AES_KEY, inner, CORP_ID)
    const signature = wecomSignature({ token: TOKEN, timestamp, nonce, encrypt: encrypted })
    const body = `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt><AgentID>1000002</AgentID></xml>`
    const result = await adapter.verifyAndParse({
      headers: {},
      rawBody: Buffer.from(body),
      query: { msg_signature: signature, timestamp, nonce },
    })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.messages[0]).toMatchObject({
      provider: 'wecom',
      providerMessageId: '1234567890',
      externalChatId: 'oc_group',
      mentionBot: true,
    })
    expect(result.events[0]?.messages[0]?.text).toBe('修复构建')
  })

  it('sends through a group-robot webhook configured on the channel', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
    }) as typeof fetch
    const adapter = makeAdapter(fetchImpl)
    const result = await adapter.send({
      chatId: 'oc_group',
      text: 'hello',
      channelConfig: { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc' },
    })
    expect(calls[0]).toContain('webhook/send')
    expect(result.messageId ?? null).toBeNull()
  })
})
