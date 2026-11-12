import { afterEach, describe, expect, it } from 'vitest'
import { count, eq } from 'drizzle-orm'
import { createHarness, type Harness } from './helpers/app.js'
import { createIm } from '../src/im/index.js'
import { encryptWecom, wecomSignature } from '../src/im/wecom-crypto.js'
import { loginWithIdentity } from '../src/services/auth.js'
import { bindChannel, bindRepo, createProject, updateProject } from '../src/services/projects.js'
import { messages, outboxEvents, tickets } from '../src/db/schema.js'

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close()
})

async function seed() {
  const h = await createHarness()
  harnesses.push(h)
  h.ctx.im = createIm(h.config, h.ctx.log).adapters
  const alice = await loginWithIdentity(h.ctx, 'wecom', { externalId: 'zhangsan', name: '张三' })
  const project = await createProject(h.ctx, alice, { name: '企微项目' })
  await bindRepo(h.ctx, project.id, alice, { installationId: '1', owner: 'demo-org', name: 'hello-world' })
  await bindChannel(h.ctx, project.id, alice, {
    provider: 'wecom',
    externalChatId: 'wc_group',
    name: '企微项目群',
    config: {
      joinUrl: 'https://work.weixin.qq.com/group/join',
      qrDataUrl: 'data:image/png;base64,AAAA',
      autoJoin: false,
    },
  })
  await updateProject(h.ctx, project.id, alice, { status: 'active' })
  return { h, project, alice }
}

function messageXml(input: { corpId: string; from: string; content: string; msgId: string }): string {
  return `<xml><ToUserName><![CDATA[${input.corpId}]]></ToUserName><FromUserName><![CDATA[${input.from}]]></FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${input.content}]]></Content><MsgId>${input.msgId}</MsgId><AgentID>1000002</AgentID><ChatId><![CDATA[wc_group]]></ChatId></xml>`
}

async function post(h: Harness, input: { from?: string; content: string; msgId: string }) {
  const corpId = h.config.WECOM_CORP_ID as string
  const token = h.config.WECOM_TOKEN as string
  const aesKey = h.config.WECOM_ENCODING_AES_KEY as string
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = 'nonce-1'
  const inner = messageXml({ corpId, from: input.from ?? 'zhangsan', content: input.content, msgId: input.msgId })
  const encrypted = encryptWecom(aesKey, inner, corpId)
  const body = `<xml><ToUserName><![CDATA[${corpId}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt><AgentID>1000002</AgentID></xml>`
  const signature = wecomSignature({ token, timestamp, nonce, encrypt: encrypted })
  return h.app.inject({
    method: 'POST',
    url: `/webhooks/wecom?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
    headers: { 'content-type': 'text/xml' },
    payload: body,
  })
}

async function ticketCount(h: Harness): Promise<number> {
  const [row] = await h.ctx.db.select({ value: count() }).from(tickets)
  return Number(row?.value ?? 0)
}

describe('WeCom intake', () => {
  it('creates a ticket from an encrypted group message and dedupes the retry', async () => {
    const { h, project } = await seed()

    const first = await post(h, { content: '@Superagent 修复构建失败', msgId: 'wc_msg_1' })
    expect(first.statusCode).toBe(200)
    expect(await ticketCount(h)).toBe(1)
    const ticket = (await h.ctx.db.select().from(tickets))[0]
    expect(ticket?.projectId).toBe(project.id)
    expect(ticket?.title).toBe('修复构建失败')
    expect(ticket?.threadKey).toBe('wc_msg_1')
    const stored = await h.ctx.db.select().from(messages).where(eq(messages.provider, 'wecom'))
    expect(stored[0]?.text).toBe('修复构建失败')

    const replay = await post(h, { content: '@Superagent 修复构建失败', msgId: 'wc_msg_1' })
    expect(replay.statusCode).toBe(200)
    expect(await ticketCount(h)).toBe(1)

    const ordinary = await post(h, { content: '普通群消息', msgId: 'wc_msg_2' })
    expect(ordinary.statusCode).toBe(200)
    expect(await ticketCount(h)).toBe(1)

    const outsider = await post(h, { content: '@Superagent 我也要改', msgId: 'wc_msg_3', from: 'lisi' })
    expect(outsider.statusCode).toBe(200)
    expect(await ticketCount(h)).toBe(1)
  })

  it('handles /status commands for a WeCom chat without native threads', async () => {
    const { h } = await seed()
    await post(h, { content: '@Superagent 修复构建失败', msgId: 'wc_cmd_1' })
    const command = await post(h, { content: '@Superagent /status', msgId: 'wc_cmd_2' })
    expect(command.statusCode).toBe(200)
    const replies = await h.ctx.db.select().from(outboxEvents).where(eq(outboxEvents.kind, 'command'))
    expect(replies.length).toBeGreaterThan(0)
    expect(replies[0]?.payload.text).toContain('修复构建失败')
  })
})
