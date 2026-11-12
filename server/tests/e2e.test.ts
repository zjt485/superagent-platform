import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { and, count, eq } from 'drizzle-orm'
import { api, cookieOf, createHarness, type Harness } from './helpers/app.js'
import { createIm } from '../src/im/index.js'
import { encryptFeishuPayload, feishuSignature } from '../src/im/feishu-crypto.js'
import { claimNextRun } from '../src/services/runs.js'
import { executeClaimedRun, type WorkerContext } from '../src/worker/pipeline.js'
import { FakeGitOps } from '../src/worker/fake-git.js'
import { FakeRuntime } from '../src/runtime/fake.js'
import { createDbQueue } from '../src/queue/index.js'
import { flushOutbox } from '../src/services/outbox.js'
import { loginWithIdentity } from '../src/services/auth.js'
import { bindChannel, bindRepo, createProject, updateProject } from '../src/services/projects.js'
import { outboxEvents, runs, tickets, users } from '../src/db/schema.js'
import { createHmac } from 'node:crypto'

const harnesses: Harness[] = []
const tempDirs: string[] = []

async function makeHarness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'superagent-test-'))
  tempDirs.push(dir)
  const harness = await createHarness({ WORKSPACES_DIR: dir, ...overrides })
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function devLogin(harness: Harness, name: string) {
  const response = await api(harness, 'POST', '/v1/auth/dev-login', { body: { name } })
  expect(response.status).toBe(200)
  return { cookie: cookieOf(response), user: response.json.user as { id: string; name: string } }
}

async function activeProject(
  harness: Harness,
  cookie: string,
  input: { name: string; policy?: Record<string, unknown> },
) {
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
  expect(
    (await api(harness, 'PATCH', `/v1/projects/${projectId}`, { cookie, body: { status: 'active' } })).status,
  ).toBe(200)
  return { projectId, cookie }
}

function workerContext(harness: Harness, runtime = new FakeRuntime()): { ctx: WorkerContext; git: FakeGitOps } {
  const git = new FakeGitOps()
  const ctx: WorkerContext = {
    config: harness.ctx.config,
    db: harness.ctx.db,
    log: harness.ctx.log,
    now: harness.ctx.now,
    queue: createDbQueue(),
    ports: { github: harness.ctx.github, git, runtime },
    heartbeatMs: 1000,
  }
  return { ctx, git }
}

async function runWorker(harness: Harness, runtime = new FakeRuntime()) {
  const { ctx } = workerContext(harness, runtime)
  const claimed = await claimNextRun(ctx, 'worker-test')
  if (!claimed) return null
  await executeClaimedRun(ctx, claimed)
  return claimed
}

describe('control plane API', () => {
  it('authenticates, isolates projects, and enforces CSRF/roles', async () => {
    const harness = await makeHarness()
    const alice = await devLogin(harness, 'Alice')
    const bob = await devLogin(harness, 'Bob')

    const a = await activeProject(harness, alice.cookie, { name: '项目 A' })
    const b = await activeProject(harness, alice.cookie, { name: '项目 B' })

    const invite = await api(harness, 'POST', `/v1/projects/${a.projectId}/invites`, {
      cookie: alice.cookie,
      body: { role: 'member', maxUses: 2, expiresInHours: 12 },
    })
    expect(invite.status).toBe(201)
    expect(invite.json.invite.qrDataUrl).toMatch(/^data:image\/png;base64,/)
    const token = invite.json.token as string

    const preview = await api(harness, 'GET', `/v1/invites/${token}`)
    expect(preview.json.invite).toMatchObject({ valid: true, project: { name: '项目 A' } })

    const accepted = await api(harness, 'POST', `/v1/invites/${token}/accept`, { cookie: bob.cookie })
    expect(accepted.status).toBe(201)
    expect(accepted.json.role).toBe('member')
    // The response carries the group entry so the invite page can offer a QR or
    // link (no Feishu adapter is configured in tests, so no auto-add).
    expect(accepted.json.group?.group?.joinUrl).toContain('applink.feishu.cn')
    expect(accepted.json.group?.joined).toBe(false)

    expect((await api(harness, 'GET', `/v1/projects/${a.projectId}`, { cookie: bob.cookie })).status).toBe(200)
    expect((await api(harness, 'GET', `/v1/projects/${b.projectId}`, { cookie: bob.cookie })).status).toBe(404)

    const forbidden = await api(harness, 'GET', `/v1/projects/${a.projectId}/audit`, { cookie: bob.cookie })
    expect(forbidden.status).toBe(403)
    expect((await api(harness, 'GET', `/v1/projects/${a.projectId}/audit`, { cookie: alice.cookie })).status).toBe(200)

    // Members cannot pause, maintainers can; archiving stays owner-only.
    expect((await api(harness, 'PATCH', `/v1/projects/${a.projectId}`, { cookie: bob.cookie, body: { status: 'paused' } })).status).toBe(403)
    expect(
      (await api(harness, 'PATCH', `/v1/projects/${a.projectId}/members/${bob.user.id}`, { cookie: alice.cookie, body: { role: 'maintainer' } })).status,
    ).toBe(200)
    expect((await api(harness, 'PATCH', `/v1/projects/${a.projectId}`, { cookie: bob.cookie, body: { status: 'paused' } })).status).toBe(200)
    expect((await api(harness, 'PATCH', `/v1/projects/${a.projectId}`, { cookie: bob.cookie, body: { status: 'active' } })).status).toBe(200)
    expect((await api(harness, 'PATCH', `/v1/projects/${a.projectId}`, { cookie: bob.cookie, body: { status: 'archived' } })).status).toBe(403)
    const listed = await api(harness, 'GET', '/v1/projects', { cookie: bob.cookie })
    expect(listed.json.items.map((item: { id: string }) => item.id)).toEqual([a.projectId])

    const csrf = await api(harness, 'POST', '/v1/projects', {
      cookie: alice.cookie,
      body: { name: '无 CSRF' },
      csrf: false,
    })
    expect(csrf.status).toBe(403)
  })

  it('runs a console ticket through plan, execution and PR delivery', async () => {
    const harness = await makeHarness({ GITHUB_WEBHOOK_SECRET: 'github-secret' })
    const alice = await devLogin(harness, 'Alice')
    const { projectId } = await activeProject(harness, alice.cookie, { name: '交付项目' })

    const created = await api(harness, 'POST', `/v1/projects/${projectId}/tickets`, {
      cookie: alice.cookie,
      body: { title: '新增欢迎页', body: '在 docs 下新增欢迎页，并说明如何验证。' },
    })
    expect(created.status).toBe(201)
    const ticketId = created.json.ticket.id as string
    expect(created.json.ticket.status).toBe('triaged')

    const planRun = await runWorker(harness)
    expect(planRun?.kind).toBe('plan')
    let ticket = await harness.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(ticket[0]?.status).toBe('running')
    expect(ticket[0]?.plan).toContain('实现需求')

    const executeRun = await runWorker(harness)
    expect(executeRun?.kind).toBe('execute')
    ticket = await harness.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(ticket[0]?.status).toBe('waiting_review')
    expect(ticket[0]?.prUrl).toContain('https://github.com/demo-org/hello-world/pull/')
    expect(ticket[0]?.branch?.startsWith('agent/')).toBe(true)

    const runRows = await harness.ctx.db.select().from(runs).where(eq(runs.ticketId, ticketId))
    expect(runRows.map((run) => run.status).sort()).toEqual(['succeeded', 'succeeded'])
    const detail = await api(harness, 'GET', `/v1/tickets/${ticketId}`, { cookie: alice.cookie })
    expect(detail.status).toBe(200)
    expect(detail.json.runs).toHaveLength(2)
    expect(detail.json.ticket.prUrl).toContain('/pull/')

    const sent: { text: string }[] = []
    harness.ctx.senders.set('feishu', {
      provider: 'feishu',
      async send(input) {
        sent.push({ text: input.text })
        return { messageId: `om_${sent.length}` }
      },
    })
    const flushed = await flushOutbox(harness.ctx, harness.ctx.senders, 50)
    expect(flushed).toBeGreaterThan(0)
    expect(sent.some((message) => message.text.includes('PR 已创建'))).toBe(true)

    // PR merged webhook closes the ticket and notifies the chat.
    const payload = JSON.stringify({
      action: 'closed',
      pull_request: {
        html_url: ticket[0]?.prUrl,
        merged: true,
        head: { ref: ticket[0]?.branch },
      },
      repository: { full_name: 'demo-org/hello-world' },
    })
    const signature = `sha256=${createHmac('sha256', 'github-secret').update(payload).digest('hex')}`
    const hook = await api(harness, 'POST', '/webhooks/github', {
      body: payload,
      csrf: false,
      headers: {
        'x-hub-signature-256': signature,
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'pull_request',
        'content-type': 'application/json',
      },
    })
    expect(hook.status).toBe(202)
    expect(hook.json.handled).toBe('merged')
    ticket = await harness.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(ticket[0]?.status).toBe('done')

    const replay = await api(harness, 'POST', '/webhooks/github', {
      body: payload,
      csrf: false,
      headers: {
        'x-hub-signature-256': signature,
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'pull_request',
        'content-type': 'application/json',
      },
    })
    expect(replay.json).toMatchObject({ ok: true, duplicate: true })
    const doneNotifications = await harness.ctx.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.projectId, projectId), eq(outboxEvents.kind, 'done')))
    expect(doneNotifications).toHaveLength(1)

    const usage = await api(harness, 'GET', `/v1/projects/${projectId}/usage`, { cookie: alice.cookie })
    expect(usage.json.series[0]?.runs).toBe(2)
    expect(usage.json.todayTokens).toBeGreaterThan(0)

    const audit = await api(harness, 'GET', `/v1/projects/${projectId}/audit`, { cookie: alice.cookie })
    const actions = audit.json.items.map((entry: { action: string }) => entry.action)
    expect(actions).toContain('ticket.created')
    expect(actions).toContain('run.succeeded')
    expect(actions).toContain('github.pr_merged')

    const runId = runRows[0]?.id as string
    const event = await api(harness, 'POST', `/internal/runs/${runId}/events`, {
      csrf: false,
      body: { type: 'note', message: 'external worker event' },
      headers: { authorization: 'Bearer test-internal-token' },
    })
    expect(event.status).toBe(200)
    const runDetail = await api(harness, 'GET', `/v1/runs/${runId}`, { cookie: alice.cookie })
    expect(runDetail.json.events.some((item: { message: string | null }) => item.message === 'external worker event')).toBe(true)
    const unauthorizedEvent = await api(harness, 'POST', `/internal/runs/${runId}/events`, {
      csrf: false,
      body: { type: 'note' },
      headers: { authorization: 'Bearer wrong' },
    })
    expect(unauthorizedEvent.status).toBe(401)
  })

  it('gates plans on maintainer approval and supports cancel/retry', async () => {
    const harness = await makeHarness()
    const alice = await devLogin(harness, 'Alice')
    const bob = await devLogin(harness, 'Bob')
    const { projectId } = await activeProject(harness, alice.cookie, {
      name: '审批项目',
      policy: { planApproval: 'required' },
    })
    const invite = await api(harness, 'POST', `/v1/projects/${projectId}/invites`, {
      cookie: alice.cookie,
      body: { role: 'member' },
    })
    await api(harness, 'POST', `/v1/invites/${invite.json.token}/accept`, { cookie: bob.cookie })

    const created = await api(harness, 'POST', `/v1/projects/${projectId}/tickets`, {
      cookie: alice.cookie,
      body: { title: '需要审批的需求', body: '实现一个需要审批的改动。' },
    })
    const ticketId = created.json.ticket.id as string
    await runWorker(harness)
    let row = (await harness.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId)))[0]
    expect(row?.status).toBe('planned')

    const denied = await api(harness, 'POST', `/v1/tickets/${ticketId}/approve`, { cookie: bob.cookie, body: {} })
    expect(denied.status).toBe(403)
    const approved = await api(harness, 'POST', `/v1/tickets/${ticketId}/approve`, { cookie: alice.cookie, body: {} })
    expect(approved.status).toBe(200)
    expect(approved.json.run.kind).toBe('execute')
    row = (await harness.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId)))[0]
    expect(row?.status).toBe('running')

    await runWorker(harness)
    row = (await harness.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId)))[0]
    expect(row?.status).toBe('waiting_review')

    const deniedCancel = await api(harness, 'POST', `/v1/tickets/${ticketId}/cancel`, { cookie: bob.cookie })
    expect(deniedCancel.status).toBe(403)
    const cancelled = await api(harness, 'POST', `/v1/tickets/${ticketId}/cancel`, { cookie: alice.cookie })
    expect(cancelled.status).toBe(200)
    expect(cancelled.json.ticket.status).toBe('cancelled')

    const retried = await api(harness, 'POST', `/v1/tickets/${ticketId}/retry`, { cookie: alice.cookie })
    expect(retried.status).toBe(200)
    expect(retried.json.ticket.status).toBe('running')
    const queued = await harness.ctx.db
      .select()
      .from(runs)
      .where(and(eq(runs.ticketId, ticketId), eq(runs.status, 'queued')))
    expect(queued).toHaveLength(1)
  })
})

describe('Feishu intake', () => {
  const ENCRYPT_KEY = 'test-encrypt-key-0123456789abcdef'

  async function seedFeishu() {
    const harness = await makeHarness()
    const im = createIm(harness.config, harness.ctx.log)
    harness.ctx.im = im.adapters
    const alice = await loginWithIdentity(harness.ctx, 'feishu', { externalId: 'ou_alice', name: 'Alice' })
    const bob = await loginWithIdentity(harness.ctx, 'feishu', { externalId: 'ou_bob', name: 'Bob' })
    const project = await createProject(harness.ctx, alice, { name: '飞书项目' })
    await bindRepo(harness.ctx, project.id, alice, { installationId: '1', owner: 'demo-org', name: 'hello-world' })
    await bindChannel(harness.ctx, project.id, alice, { provider: 'feishu', externalChatId: 'oc_project', name: '项目群' })
    await updateProject(harness.ctx, project.id, alice, { status: 'active' })
    return { harness, alice, bob, project }
  }

  function event(input: {
    eventId: string
    messageId: string
    text?: string
    sender?: string
    mention?: boolean
    rootId?: string
  }) {
    return {
      schema: '2.0',
      header: {
        event_id: input.eventId,
        event_type: 'im.message.receive_v1',
        token: 'test-verification-token',
        create_time: String(Date.now()),
      },
      event: {
        sender: { sender_id: { open_id: input.sender ?? 'ou_alice' }, sender_type: 'user' },
        message: {
          message_id: input.messageId,
          chat_id: 'oc_project',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: input.text ?? '@_user_1 修复登录页' }),
          ...(input.mention === false
            ? { mentions: [] }
            : { mentions: [{ key: '@_user_1', name: 'Superagent', id: { open_id: 'ou_bot' } }] }),
          ...(input.rootId ? { root_id: input.rootId, parent_id: input.rootId } : {}),
        },
      },
    }
  }

  async function post(harness: Harness, payload: unknown) {
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
      },
    })
  }

  async function ticketCount(harness: Harness) {
    const [row] = await harness.ctx.db.select({ value: count() }).from(tickets)
    return Number(row?.value ?? 0)
  }

  it('creates one ticket per @bot request, dedupes replays and appends thread replies', async () => {
    const { harness, project } = await seedFeishu()

    const first = await post(harness, event({ eventId: 'evt_1', messageId: 'om_1' }))
    expect(first.status).toBe(200)
    expect(first.json.processed).toBe(1)
    expect(await ticketCount(harness)).toBe(1)
    const ticket = (await harness.ctx.db.select().from(tickets))[0]
    expect(ticket?.threadKey).toBe('om_1')
    expect(ticket?.title).toBe('修复登录页')
    const receipts = await harness.ctx.db.select().from(outboxEvents).where(eq(outboxEvents.kind, 'receipt'))
    expect(receipts).toHaveLength(1)

    const replay = await post(harness, event({ eventId: 'evt_1', messageId: 'om_1' }))
    expect(replay.json.processed).toBe(0)
    expect(await ticketCount(harness)).toBe(1)

    const duplicateMessage = await post(harness, event({ eventId: 'evt_same_message', messageId: 'om_1' }))
    expect(duplicateMessage.status).toBe(200)
    expect(await ticketCount(harness)).toBe(1)

    // Thread reply without a mention continues the same ticket.
    const reply = await post(harness, event({ eventId: 'evt_2', messageId: 'om_2', text: '补充：只改文案', rootId: 'om_1', mention: false }))
    expect(reply.json.processed).toBe(1)
    expect(await ticketCount(harness)).toBe(1)

    // A new top-level message without a mention is ignored.
    const ignored = await post(harness, event({ eventId: 'evt_3', messageId: 'om_3', text: '普通群聊消息', mention: false }))
    expect(ignored.json.processed).toBe(1)
    expect(await ticketCount(harness)).toBe(1)
    const ignoredRows = await harness.ctx.db.select().from(tickets)
    expect(ignoredRows).toHaveLength(1)

    // A non-member mention is ignored and never creates a ticket.
    const outsider = await post(harness, event({ eventId: 'evt_4', messageId: 'om_4', sender: 'ou_bob' }))
    expect(outsider.json.processed).toBe(1)
    expect(await ticketCount(harness)).toBe(1)

    // /status command replies in the thread.
    const status = await post(
      harness,
      event({ eventId: 'evt_5', messageId: 'om_5', text: '@_user_1 /status', rootId: 'om_1' }),
    )
    expect(status.status).toBe(200)
    const commands = await harness.ctx.db.select().from(outboxEvents).where(eq(outboxEvents.kind, 'command'))
    expect(commands.length).toBeGreaterThan(0)

    const projectRow = (await harness.ctx.db.select().from(users).where(eq(users.id, project.ownerId)))[0]
    expect(projectRow?.name).toBe('Alice')
  })

  it('rejects messages while paused and accepts /bind in an unbound chat', async () => {
    const { harness, alice, project } = await seedFeishu()
    await updateProject(harness.ctx, project.id, alice, { status: 'paused' })
    const paused = await post(harness, event({ eventId: 'evt_paused', messageId: 'om_paused' }))
    expect(paused.status).toBe(200)
    expect(await ticketCount(harness)).toBe(0)
    await updateProject(harness.ctx, project.id, alice, { status: 'active' })

    // A second project, bound from the chat itself via @bot /bind <slug>.
    const other = await createProject(harness.ctx, alice, { name: '待绑定项目' })
    await bindRepo(harness.ctx, other.id, alice, { installationId: '1', owner: 'demo-org', name: 'hello-world' })
    const bindEvent = event({
      eventId: 'evt_bind',
      messageId: 'om_bind',
      text: `@_user_1 /bind ${other.slug}`,
    })
    const bindEventObj = bindEvent as any
    bindEventObj.event.message.chat_id = 'oc_unbound'
    const bound = await post(harness, bindEventObj)
    expect(bound.status).toBe(200)
    const channels = await harness.ctx.db.select().from(
      (await import('../src/db/schema.js')).channels,
    )
    expect(channels.some((channel) => channel.externalChatId === 'oc_unbound' && channel.projectId === other.id)).toBe(true)
  })
})
