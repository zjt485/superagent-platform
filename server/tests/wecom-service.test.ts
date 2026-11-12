import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { count, eq } from 'drizzle-orm'
import { createHarness, type Harness } from './helpers/app.js'
import { createIm } from '../src/im/index.js'
import { encryptWecom, wecomSignature } from '../src/im/wecom-crypto.js'
import { loginWithIdentity } from '../src/services/auth.js'
import { bindChannel, bindRepo, createProject, updateProject } from '../src/services/projects.js'
import { claimNextTurn } from '../src/dual/sessions.js'
import { executeTurn, type DualWorkerContext } from '../src/dual/worker.js'
import { FakeGitOps } from '../src/worker/fake-git.js'
import { FakeTurnRuntime } from '../src/dual/runtime.js'
import { createDbQueue } from '../src/queue/index.js'
import { evaluations, outboxEvents, tickets } from '../src/db/schema.js'

const harnesses: Harness[] = []
const dirs: string[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function seed() {
  const dir = await mkdtemp(path.join(tmpdir(), 'wecom-dual-'))
  dirs.push(dir)
  const h = await createHarness({ WORKSPACES_DIR: dir })
  harnesses.push(h)
  h.ctx.im = createIm(h.config, h.ctx.log).adapters
  const alice = await loginWithIdentity(h.ctx, 'wecom', { externalId: 'zhangsan', name: '张三' })
  const project = await createProject(h.ctx, alice, { name: '企微双 Agent' })
  await bindRepo(h.ctx, project.id, alice, { installationId: '1', owner: 'demo-org', name: 'hello-world' })
  await bindChannel(h.ctx, project.id, alice, { provider: 'wecom', externalChatId: 'wc_group', name: '企微群' })
  await updateProject(h.ctx, project.id, alice, { status: 'active' })
  return { h, project, alice }
}

async function drain(h: Harness) {
  const ctx: DualWorkerContext = {
    ...h.ctx,
    queue: createDbQueue(),
    ports: { github: h.ctx.github, git: new FakeGitOps(), runtime: new FakeTurnRuntime({ delayMs: 1 }) },
  }
  for (let index = 0; index < 8; index += 1) {
    const turn = await claimNextTurn(ctx, 'wecom-worker')
    if (!turn) break
    await executeTurn(ctx, turn)
  }
}

async function post(h: Harness, input: { msgId: string; content: string; from?: string }) {
  const corpId = h.config.WECOM_CORP_ID as string
  const token = h.config.WECOM_TOKEN as string
  const aesKey = h.config.WECOM_ENCODING_AES_KEY as string
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = 'nonce-1'
  const inner = `<xml><ToUserName><![CDATA[${corpId}]]></ToUserName><FromUserName><![CDATA[${input.from ?? 'zhangsan'}]]></FromUserName><CreateTime>${timestamp}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${input.content}]]></Content><MsgId>${input.msgId}</MsgId><AgentID>1000002</AgentID><ChatId><![CDATA[wc_group]]></ChatId></xml>`
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

describe('WeCom dual-agent intake', () => {
  it('creates an Eval from an encrypted group message, then a Ticket through the Main Session', async () => {
    const { h } = await seed()
    const response = await post(h, { msgId: 'wc_msg_1', content: '@Superagent 修复构建失败' })
    expect(response.statusCode).toBe(200)
    expect(await h.ctx.db.select().from(tickets)).toHaveLength(0)
    expect(await h.ctx.db.select().from(evaluations)).toHaveLength(1)
    await drain(h)
    const [ticket] = await h.ctx.db.select().from(tickets)
    expect(ticket?.title).toBe('修复构建失败')
    expect(ticket?.stage).toBe('review')

    const replay = await post(h, { msgId: 'wc_msg_1', content: '@Superagent 修复构建失败' })
    expect(replay.statusCode).toBe(200)
    expect(Number((await h.ctx.db.select({ value: count() }).from(evaluations))[0]?.value ?? 0)).toBe(1)

    const command = await post(h, { msgId: 'wc_cmd_1', content: '@Superagent /status' })
    expect(command.statusCode).toBe(200)
    const replies = await h.ctx.db.select().from(outboxEvents).where(eq(outboxEvents.kind, 'command'))
    expect(replies.length).toBeGreaterThan(0)
    expect(replies[0]?.payload.text).toContain('修复构建失败')
  })
})
