import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { and, count, eq } from 'drizzle-orm'
import { api, cookieOf, createHarness, type Harness } from './helpers/app.js'
import { createIm } from '../src/im/index.js'
import { encryptFeishuPayload, feishuSignature } from '../src/im/feishu-crypto.js'
import { coreTick } from '../src/core/worker/tick.js'
import { dispatchOnce } from '../src/core/worker/dispatcher.js'
import { RuntimeExecutor } from '../src/core/worker/runtime-executor.js'
import { GitDeliveryProvider } from '../src/core/worker/delivery.js'
import { createDbWorkspaceProvider } from '../src/core/worker/workspace-provider.js'
import { RuleBasedRouterModel } from '../src/core/router/model.js'
import { FakeGitOps } from '../src/worker/fake-git.js'
import { FakeTurnRuntime } from '../src/core/agent/runtime.js'
import { flushOutbox } from '../src/services/outbox.js'
import { loginWithIdentity } from '../src/services/auth.js'
import { bindChannel, bindRepo, createProject, updateProject } from '../src/services/projects.js'
import {
  evaluations,
  outboxEvents,
  reports,
  sessionTurns,
  tickets,
  triggers,
} from '../src/db/schema.js'
import { createHmac } from 'node:crypto'

const harnesses: Harness[] = []
const tempDirs: string[] = []

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function makeHarness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'core-service-'))
  tempDirs.push(dir)
  const harness = await createHarness({ WORKSPACES_DIR: dir, ...overrides })
  harnesses.push(harness)
  return harness
}

async function drain(harness: Harness, max = 12, runtime = new FakeTurnRuntime({ delayMs: 1 })): Promise<number> {
  const workspace = createDbWorkspaceProvider({
    db: harness.ctx.db,
    rootDir: harness.config.WORKSPACES_DIR,
    github: harness.ctx.github,
    webBase: harness.config.GITHUB_WEB_BASE,
  })
  const delivery = new GitDeliveryProvider({
    db: harness.ctx.db,
    git: new FakeGitOps(),
    github: harness.ctx.github,
    author: { name: harness.config.GIT_AUTHOR_NAME, email: harness.config.GIT_AUTHOR_EMAIL },
    webBase: harness.config.GITHUB_WEB_BASE,
  })
  const executor = new RuntimeExecutor(runtime)
  await coreTick({ db: harness.ctx.db, model: new RuleBasedRouterModel(), now: harness.ctx.now, maxThreads: 10 })
  let countRan = 0
  for (let index = 0; index < max; index += 1) {
    const ran = await dispatchOnce({
      db: harness.ctx.db,
      executor,
      workspace,
      delivery,
      now: harness.ctx.now,
    })
    if (!ran) break
    countRan += 1
  }
  return countRan
}

async function devLogin(harness: Harness, name: string) {
  const response = await api(harness, 'POST', '/v1/auth/dev-login', { body: { name } })
  expect(response.status).toBe(200)
  return { cookie: cookieOf(response), user: response.json.user as { id: string; name: string } }
}

async function activeProject(harness: Harness, cookie: string, input: { name: string; policy?: Record<string, unknown> }) {
  const created = await api(harness, 'POST', '/v1/projects', {
    cookie,
    body: { name: input.name, ...(input.policy ? { policy: input.policy } : {}) },
  })
  expect(created.status).toBe(201)
  const projectId = created.json.project.id as string
  expect(
    (
      await api(harness, 'POST', `/v1/projects/${projectId}/repo`, {
        cookie,
        body: { installationId: '1', owner: 'demo-org', name: 'hello-world', defaultBranch: 'main' },
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await api(harness, 'POST', `/v1/projects/${projectId}/channels`, {
        cookie,
        body: { provider: 'feishu', externalChatId: `oc_${projectId.slice(0, 8)}`, name: '项目群' },
      })
    ).status,
  ).toBe(201)
  expect((await api(harness, 'PATCH', `/v1/projects/${projectId}`, { cookie, body: { status: 'active' } })).status).toBe(200)
  return projectId
}

describe('core service', () => {
  it('authenticates, isolates projects, enforces roles and the invite flow', async () => {
    const harness = await makeHarness()
    const alice = await devLogin(harness, 'Alice')
    const bob = await devLogin(harness, 'Bob')
    const a = await activeProject(harness, alice.cookie, { name: '项目 A' })
    const b = await activeProject(harness, alice.cookie, { name: '项目 B' })

    const invite = await api(harness, 'POST', `/v1/projects/${a}/invites`, {
      cookie: alice.cookie,
      body: { role: 'member', maxUses: 2, expiresInHours: 12 },
    })
    expect(invite.status).toBe(201)
    expect(invite.json.invite.qrDataUrl).toMatch(/^data:image\/png;base64,/)
    const token = invite.json.token as string
    expect((await api(harness, 'GET', `/v1/invites/${token}`)).json.invite.valid).toBe(true)
    const accepted = await api(harness, 'POST', `/v1/invites/${token}/accept`, { cookie: bob.cookie })
    expect(accepted.status).toBe(201)
    expect(accepted.json.group?.group?.joinUrl).toContain('applink.feishu.cn')

    expect((await api(harness, 'GET', `/v1/projects/${a}`, { cookie: bob.cookie })).status).toBe(200)
    expect((await api(harness, 'GET', `/v1/projects/${b}`, { cookie: bob.cookie })).status).toBe(404)
    expect((await api(harness, 'GET', `/v1/projects/${a}/audit`, { cookie: bob.cookie })).status).toBe(403)

    expect((await api(harness, 'POST', '/v1/projects', { cookie: alice.cookie, body: { name: '无 CSRF' }, csrf: false })).status).toBe(403)
    expect((await api(harness, 'PATCH', `/v1/projects/${a}`, { cookie: bob.cookie, body: { status: 'paused' } })).status).toBe(403)
    expect(
      (await api(harness, 'PATCH', `/v1/projects/${a}/members/${bob.user.id}`, { cookie: alice.cookie, body: { role: 'maintainer' } })).status,
    ).toBe(200)
    expect((await api(harness, 'PATCH', `/v1/projects/${a}`, { cookie: bob.cookie, body: { status: 'paused' } })).status).toBe(200)
    expect((await api(harness, 'PATCH', `/v1/projects/${a}`, { cookie: bob.cookie, body: { status: 'active' } })).status).toBe(200)
    expect((await api(harness, 'PATCH', `/v1/projects/${a}`, { cookie: bob.cookie, body: { status: 'archived' } })).status).toBe(403)
  })

  it('runs a console ticket through Executor to a PR and closes it on merge', async () => {
    const harness = await makeHarness({ GITHUB_WEBHOOK_SECRET: 'github-secret' })
    const alice = await devLogin(harness, 'Alice')
    const projectId = await activeProject(harness, alice.cookie, { name: '交付项目' })

    const created = await api(harness, 'POST', `/v1/projects/${projectId}/tickets`, {
      cookie: alice.cookie,
      body: { title: '新增欢迎页', body: '在 docs 下新增欢迎页并说明验证方式。' },
    })
    expect(created.status).toBe(201)
    const ticketId = created.json.ticket.id as string
    expect(created.json.ticket.stage).toBe('queued')

    const turns = await drain(harness)
    expect(turns).toBe(1)
    let [ticket] = await harness.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(ticket?.stage).toBe('review')
    expect(ticket?.status).toBe('waiting_review')
    expect(ticket?.prUrl).toContain('/pull/')
    expect((await harness.ctx.db.select().from(reports)).length).toBeGreaterThan(0)

    const [executorTurn] = await harness.ctx.db.select().from(sessionTurns).where(eq(sessionTurns.ticketId, ticketId))
    expect(executorTurn?.kind).toBe('execute')
    const events = await api(harness, 'GET', `/v1/runs/${executorTurn!.id}`, { cookie: alice.cookie })
    expect(events.status).toBe(200)
    expect(events.json.run.turnKind).toBe('execute')
    expect(Array.isArray(events.json.events)).toBe(true)

    const sent: { text: string }[] = []
    harness.ctx.senders.set('feishu', {
      provider: 'feishu',
      async send(input) {
        sent.push({ text: input.text })
        return { messageId: `om_${sent.length}` }
      },
    })
    expect(await flushOutbox(harness.ctx, harness.ctx.senders, 50)).toBeGreaterThan(0)
    expect(sent.some((message) => message.text.includes('PR 已创建'))).toBe(true)

    const payload = JSON.stringify({
      action: 'closed',
      pull_request: { html_url: ticket?.prUrl, merged: true, head: { ref: ticket?.branch } },
      repository: { full_name: 'demo-org/hello-world' },
    })
    const signature = `sha256=${createHmac('sha256', 'github-secret').update(payload).digest('hex')}`
    const hook = await api(harness, 'POST', '/webhooks/github', {
      body: payload,
      csrf: false,
      headers: {
        'x-hub-signature-256': signature,
        'x-github-delivery': 'core-delivery-1',
        'x-github-event': 'pull_request',
        'content-type': 'application/json',
      },
    })
    expect(hook.status).toBe(202)
    expect(hook.json.handled).toBe('merged')
    ;[ticket] = await harness.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(ticket?.stage).toBe('done')

    const replay = await api(harness, 'POST', '/webhooks/github', {
      body: payload,
      csrf: false,
      headers: {
        'x-hub-signature-256': signature,
        'x-github-delivery': 'core-delivery-1',
        'x-github-event': 'pull_request',
        'content-type': 'application/json',
      },
    })
    expect(replay.json.duplicate).toBe(true)
    const done = await harness.ctx.db.select().from(outboxEvents).where(and(eq(outboxEvents.projectId, projectId), eq(outboxEvents.kind, 'done')))
    expect(done).toHaveLength(1)

    const audit = await api(harness, 'GET', `/v1/projects/${projectId}/audit`, { cookie: alice.cookie })
    const actions = audit.json.items.map((entry: { action: string }) => entry.action)
    expect(actions).toContain('ticket.created')
    expect(actions).toContain('turn.succeeded')
    expect(actions).toContain('github.pr_merged')
    const usage = await api(harness, 'GET', `/v1/projects/${projectId}/usage`, { cookie: alice.cookie })
    expect(usage.json.series[0]?.runs).toBe(1)
  })

  it('gates plans, approves through the API, then cancels and retries', async () => {
    const harness = await makeHarness()
    const alice = await devLogin(harness, 'Alice')
    const bob = await devLogin(harness, 'Bob')
    const projectId = await activeProject(harness, alice.cookie, { name: '审批项目', policy: { planApproval: 'required' } })
    const invite = await api(harness, 'POST', `/v1/projects/${projectId}/invites`, { cookie: alice.cookie, body: { role: 'member' } })
    await api(harness, 'POST', `/v1/invites/${invite.json.token}/accept`, { cookie: bob.cookie })

    const created = await api(harness, 'POST', `/v1/projects/${projectId}/tickets`, {
      cookie: alice.cookie,
      body: { title: '需要审批的需求', body: '实现一个需要审批的改动。' },
    })
    const ticketId = created.json.ticket.id as string
    await drain(harness)
    let [ticket] = await harness.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(ticket?.stage).toBe('plan_review')

    expect((await api(harness, 'POST', `/v1/tickets/${ticketId}/approve`, { cookie: bob.cookie, body: {} })).status).toBe(403)
    expect((await api(harness, 'POST', `/v1/tickets/${ticketId}/approve`, { cookie: alice.cookie, body: {} })).status).toBe(200)
    await drain(harness)
    ;[ticket] = await harness.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(ticket?.stage).toBe('review')

    expect((await api(harness, 'POST', `/v1/tickets/${ticketId}/cancel`, { cookie: bob.cookie })).status).toBe(403)
    expect((await api(harness, 'POST', `/v1/tickets/${ticketId}/cancel`, { cookie: alice.cookie })).status).toBe(200)
    ;[ticket] = await harness.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(ticket?.stage).toBe('cancelled')
    expect((await api(harness, 'POST', `/v1/tickets/${ticketId}/retry`, { cookie: alice.cookie })).status).toBe(409)

    const failing = await api(harness, 'POST', `/v1/projects/${projectId}/tickets`, {
      cookie: alice.cookie,
      body: { title: '失败后重试', body: '先失败一次，再重试成功。' },
    })
    const failingId = failing.json.ticket.id as string
    await drain(harness)
    ;[ticket] = await harness.ctx.db.select().from(tickets).where(eq(tickets.id, failingId))
    expect(ticket?.stage).toBe('plan_review')
    expect((await api(harness, 'POST', `/v1/tickets/${failingId}/approve`, { cookie: alice.cookie, body: {} })).status).toBe(200)
    await drain(harness, 12, new FakeTurnRuntime({ executorFail: true }))
    ;[ticket] = await harness.ctx.db.select().from(tickets).where(eq(tickets.id, failingId))
    expect(ticket?.stage).toBe('failed')
    expect((await api(harness, 'POST', `/v1/tickets/${failingId}/retry`, { cookie: alice.cookie })).status).toBe(200)
    await drain(harness)
    ;[ticket] = await harness.ctx.db.select().from(tickets).where(eq(tickets.id, failingId))
    expect(ticket?.stage).toBe('review')
  })

  it('creates an active project without requiring a GitHub repo or IM channel', async () => {
    const harness = await makeHarness()
    const alice = await devLogin(harness, 'Alice')
    const createdProject = await api(harness, 'POST', '/v1/projects', {
      cookie: alice.cookie,
      body: { name: '纯调研项目' },
    })
    expect(createdProject.status).toBe(201)
    expect(createdProject.json.project.status).toBe('active')
    expect(createdProject.json.project.readiness.canActivate).toBe(true)

    const projectId = createdProject.json.project.id as string
    const createdTicket = await api(harness, 'POST', `/v1/projects/${projectId}/tickets`, {
      cookie: alice.cookie,
      body: { title: '竞品调研', body: '梳理竞品交互方案。' },
    })
    expect(createdTicket.status).toBe(201)
    expect(await drain(harness)).toBe(1)
    const [ticket] = await harness.ctx.db.select().from(tickets).where(eq(tickets.id, createdTicket.json.ticket.id))
    expect(ticket?.stage).toBe('review')
  })
})

describe('Feishu core intake', () => {
  const ENCRYPT_KEY = 'test-encrypt-key-0123456789abcdef'

  async function seed() {
    const harness = await makeHarness()
    harness.ctx.im = createIm(harness.config, harness.ctx.log).adapters
    const alice = await loginWithIdentity(harness.ctx, 'feishu', { externalId: 'ou_alice', name: 'Alice' })
    const project = await createProject(harness.ctx, alice, { name: '飞书 Core' })
    await bindRepo(harness.ctx, project.id, alice, { installationId: '1', owner: 'demo-org', name: 'hello-world' })
    await bindChannel(harness.ctx, project.id, alice, { provider: 'feishu', externalChatId: 'oc_project', name: '项目群' })
    return { harness, project, alice }
  }

  function event(input: { eventId: string; messageId: string; text?: string; sender?: string; mention?: boolean; rootId?: string }) {
    return {
      schema: '2.0',
      header: { event_id: input.eventId, event_type: 'im.message.receive_v1', token: 'test-verification-token', create_time: String(Date.now()) },
      event: {
        sender: { sender_id: { open_id: input.sender ?? 'ou_alice' }, sender_type: 'user' },
        message: {
          message_id: input.messageId,
          chat_id: 'oc_project',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: input.text ?? '@_user_1 修复登录页' }),
          ...(input.mention === false ? { mentions: [] } : { mentions: [{ key: '@_user_1', name: 'Superagent', id: { open_id: 'ou_bot' } }] }),
          ...(input.rootId ? { root_id: input.rootId, parent_id: input.rootId } : {}),
        },
      },
    }
  }

  async function post(harness: Harness, payload: unknown, eventId: string) {
    const plain = JSON.stringify(payload)
    const body = JSON.stringify({ encrypt: encryptFeishuPayload(ENCRYPT_KEY, plain) })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = 'nonce-1'
    const signature = feishuSignature({ timestamp, nonce, encryptKey: ENCRYPT_KEY, rawBody: body })
    return api(harness, 'POST', '/webhooks/feishu', {
      body,
      csrf: false,
      headers: {
        'content-type': 'application/json',
        'x-lark-request-timestamp': timestamp,
        'x-lark-request-nonce': nonce,
        'x-lark-signature': signature,
        'x-github-delivery': eventId,
      },
    })
  }

  it('routes an @bot message through the core Router and attaches thread follow-ups to the same ticket', async () => {
    const { harness } = await seed()
    const first = await post(harness, event({ eventId: 'evt_1', messageId: 'om_1' }), 'evt_1')
    expect(first.status).toBe(200)
    expect(first.json.processed).toBe(1)
    expect(await harness.ctx.db.select().from(tickets)).toHaveLength(0)
    expect(await harness.ctx.db.select().from(triggers)).toHaveLength(1)
    await drain(harness)
    const [ticket] = await harness.ctx.db.select().from(tickets)
    expect(ticket?.title).toBe('修复登录页')
    expect(ticket?.stage).toBe('review')

    const replay = await post(harness, event({ eventId: 'evt_1', messageId: 'om_1' }), 'evt_1')
    expect(replay.json.processed).toBe(0)

    const follow = await post(harness, event({ eventId: 'evt_2', messageId: 'om_2', text: '补充：只改文案', mention: false, rootId: 'om_1' }), 'evt_2')
    expect(follow.status).toBe(200)
    await drain(harness)
    const allTickets = await harness.ctx.db.select().from(tickets)
    expect(allTickets).toHaveLength(1)
    expect(allTickets[0]?.stage).toBe('review')
    expect(await harness.ctx.db.select().from(sessionTurns)).toHaveLength(2)

    const ignored = await post(harness, event({ eventId: 'evt_3', messageId: 'om_3', text: '普通群聊', mention: false }), 'evt_3')
    expect(ignored.status).toBe(200)
    await drain(harness)
    expect(await harness.ctx.db.select().from(tickets)).toHaveLength(1)

    const outsider = await post(harness, event({ eventId: 'evt_4', messageId: 'om_4', sender: 'ou_bob' }), 'evt_4')
    expect(outsider.status).toBe(200)
    await drain(harness)
    expect(await harness.ctx.db.select().from(tickets)).toHaveLength(1)
  })

  it('replies to /status and refuses paused projects', async () => {
    const { harness, alice, project } = await seed()
    await post(harness, event({ eventId: 'evt_c1', messageId: 'om_c1' }), 'evt_c1')
    await drain(harness)
    const command = await post(harness, event({ eventId: 'evt_c2', messageId: 'om_c2', text: '@_user_1 /status', rootId: 'om_c1' }), 'evt_c2')
    expect(command.status).toBe(200)
    const replies = await harness.ctx.db.select().from(outboxEvents).where(eq(outboxEvents.kind, 'command'))
    expect(replies.length).toBeGreaterThan(0)
    expect(replies[0]?.payload.text).toContain('修复登录页')

    await updateProject(harness.ctx, project.id, alice, { status: 'paused' })
    await post(harness, event({ eventId: 'evt_p', messageId: 'om_p' }), 'evt_p')
    await drain(harness)
    expect(Number((await harness.ctx.db.select({ value: count() }).from(evaluations))[0]?.value ?? 0)).toBe(1)
    await updateProject(harness.ctx, project.id, alice, { status: 'active' })
  })
})
