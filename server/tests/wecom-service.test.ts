import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { count, eq } from 'drizzle-orm'
import { createHarness, type Harness } from './helpers/app.js'
import { createIm } from '../src/im/index.js'
import { encryptWecom, wecomSignature } from '../src/im/wecom-crypto.js'
import { loginWithIdentity } from '../src/services/auth.js'
import { bindChannel, bindRepo, createProject } from '../src/services/projects.js'
import { coreTick } from '../src/core/worker/tick.js'
import { dispatchOnce } from '../src/core/worker/dispatcher.js'
import { RuntimeExecutor } from '../src/core/worker/runtime-executor.js'
import { GitDeliveryProvider } from '../src/core/worker/delivery.js'
import { createDbWorkspaceProvider } from '../src/core/worker/workspace-provider.js'
import { RuleBasedRouterModel } from '../src/core/router/model.js'
import { FakeGitOps } from '../src/worker/fake-git.js'
import { FakeTurnRuntime } from '../src/core/agent/runtime.js'
import { evaluations, outboxEvents, tickets, triggers } from '../src/db/schema.js'

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
  const dir = await mkdtemp(path.join(tmpdir(), 'wecom-core-'))
  dirs.push(dir)
  const h = await createHarness({ WORKSPACES_DIR: dir })
  harnesses.push(h)
  h.ctx.im = createIm(h.config, h.ctx.log).adapters
  const alice = await loginWithIdentity(h.ctx, 'wecom', { externalId: 'zhangsan', name: '张三' })
  const project = await createProject(h.ctx, alice, { name: '企微 Core' })
  await bindRepo(h.ctx, project.id, alice, { installationId: '1', owner: 'demo-org', name: 'hello-world' })
  await bindChannel(h.ctx, project.id, alice, { provider: 'wecom', externalChatId: 'wc_group', name: '企微群' })
  return { h, project, alice }
}

async function drain(h: Harness) {
  const workspace = createDbWorkspaceProvider({
    db: h.ctx.db,
    rootDir: h.config.WORKSPACES_DIR,
    github: h.ctx.github,
    webBase: h.config.GITHUB_WEB_BASE,
  })
  const delivery = new GitDeliveryProvider({
    db: h.ctx.db,
    git: new FakeGitOps(),
    github: h.ctx.github,
    author: { name: h.config.GIT_AUTHOR_NAME, email: h.config.GIT_AUTHOR_EMAIL },
    webBase: h.config.GITHUB_WEB_BASE,
  })
  const executor = new RuntimeExecutor(new FakeTurnRuntime({ delayMs: 1 }))
  await coreTick({ db: h.ctx.db, model: new RuleBasedRouterModel(), now: h.ctx.now, maxThreads: 10 })
  for (let index = 0; index < 8; index += 1) {
    const ran = await dispatchOnce({ db: h.ctx.db, executor, workspace, delivery, now: h.ctx.now })
    if (!ran) break
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

describe('WeCom core intake', () => {
  it('queues a trigger from an encrypted group message, routes it to a Ticket and handles /status', async () => {
    const { h } = await seed()
    const response = await post(h, { msgId: 'wc_msg_1', content: '@Superagent 修复构建失败' })
    expect(response.statusCode).toBe(200)
    expect(await h.ctx.db.select().from(tickets)).toHaveLength(0)
    expect(await h.ctx.db.select().from(triggers)).toHaveLength(1)
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
