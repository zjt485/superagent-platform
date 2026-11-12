import { afterEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createHmac } from 'node:crypto'
import { api, createHarness, cookieOf, type Harness } from './helpers/app.js'
import { claimNextRun } from '../src/services/runs.js'
import { reapStaleRuns } from '../src/services/orchestrator.js'
import { executeClaimedRun, type WorkerContext } from '../src/worker/pipeline.js'
import { FakeGitOps } from '../src/worker/fake-git.js'
import { FakeRuntime } from '../src/runtime/fake.js'
import { createDbQueue } from '../src/queue/index.js'
import { runs, tickets } from '../src/db/schema.js'

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close()
})

async function harness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const instance = await createHarness({ RUN_LEASE_SECONDS: 60, ...overrides })
  harnesses.push(instance)
  return instance
}

async function login(h: Harness, name: string) {
  const response = await api(h, 'POST', '/v1/auth/dev-login', { body: { name } })
  return { cookie: cookieOf(response), user: response.json.user as { id: string; name: string } }
}

async function project(h: Harness, cookie: string, policy?: Record<string, unknown>) {
  const created = await api(h, 'POST', '/v1/projects', { cookie, body: { name: `项目-${Date.now()}`, ...(policy ? { policy } : {}) } })
  const projectId = created.json.project.id as string
  await api(h, 'POST', `/v1/projects/${projectId}/repo`, {
    cookie,
    body: { installationId: '1', owner: 'demo-org', name: 'hello-world', defaultBranch: 'main' },
  })
  await api(h, 'POST', `/v1/projects/${projectId}/channels`, {
    cookie,
    body: { provider: 'feishu', externalChatId: `oc_${projectId.slice(0, 8)}` },
  })
  await api(h, 'PATCH', `/v1/projects/${projectId}`, { cookie, body: { status: 'active' } })
  return projectId
}

function workerCtx(h: Harness): WorkerContext {
  return {
    config: h.config,
    db: h.ctx.db,
    log: h.ctx.log,
    now: h.ctx.now,
    queue: createDbQueue(),
    ports: { github: h.ctx.github, git: new FakeGitOps(), runtime: new FakeRuntime() },
    heartbeatMs: 1000,
  }
}

describe('run lifecycle edge cases', () => {
  it('reaps a run whose worker stopped heartbeating', async () => {
    const h = await harness({ GITHUB_WEBHOOK_SECRET: 'secret' })
    const alice = await login(h, 'Alice')
    const projectId = await project(h, alice.cookie, { retryOnFailure: false })
    const created = await api(h, 'POST', `/v1/projects/${projectId}/tickets`, {
      cookie: alice.cookie,
      body: { title: '超时任务', body: '验证心跳超时回收。' },
    })
    const ticketId = created.json.ticket.id as string
    const ctx = workerCtx(h)
    const run = await claimNextRun(ctx, 'dead-worker')
    expect(run).not.toBeNull()
    await h.ctx.db
      .update(runs)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(runs.id, run!.id))

    const reaped = await reapStaleRuns({ ...ctx, queue: createDbQueue() })
    expect(reaped).toBe(1)
    const runRow = (await h.ctx.db.select().from(runs).where(eq(runs.id, run!.id)))[0]
    expect(runRow?.status).toBe('timeout')
    const ticket = (await h.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId)))[0]
    expect(ticket?.status).toBe('failed')
  })

  it('starts a new execute run when a PR review comment arrives', async () => {
    const h = await harness({ GITHUB_WEBHOOK_SECRET: 'secret' })
    const alice = await login(h, 'Alice')
    const projectId = await project(h, alice.cookie)
    const created = await api(h, 'POST', `/v1/projects/${projectId}/tickets`, {
      cookie: alice.cookie,
      body: { title: '需要评审迭代', body: '先实现，再按评审意见修改。' },
    })
    const ticketId = created.json.ticket.id as string
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const run = await claimNextRun(workerCtx(h), 'worker')
      if (run) await executeClaimedRun(workerCtx(h), run)
    }
    let ticket = (await h.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId)))[0]
    expect(ticket?.status).toBe('waiting_review')

    const payload = JSON.stringify({
      action: 'created',
      issue: { number: 7, html_url: ticket?.prUrl, pull_request: { url: 'x' } },
      comment: { id: 9001, body: '请把文案改成中文', user: { login: 'reviewer' }, html_url: 'x' },
      sender: { type: 'User', login: 'reviewer' },
      repository: { full_name: 'demo-org/hello-world' },
    })
    const signature = `sha256=${createHmac('sha256', 'secret').update(payload).digest('hex')}`
    const response = await api(h, 'POST', '/webhooks/github', {
      body: payload,
      csrf: false,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'review-comment-1',
        'x-github-event': 'issue_comment',
      },
    })
    expect(response.status).toBe(202)
    ticket = (await h.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId)))[0]
    expect(ticket?.status).toBe('running')
    const queued = await h.ctx.db
      .select()
      .from(runs)
      .where(and(eq(runs.ticketId, ticketId), eq(runs.status, 'queued')))
    expect(queued).toHaveLength(1)
    expect(queued[0]?.kind).toBe('execute')
  })

  it('enforces the daily token budget before queueing', async () => {
    const h = await harness()
    const alice = await login(h, 'Alice')
    const projectId = await project(h, alice.cookie, { dailyTokenBudget: 10 })
    const { usage } = await import('../src/db/schema.js')
    await h.ctx.db.insert(usage).values({
      id: crypto.randomUUID(),
      projectId,
      day: new Date().toISOString().slice(0, 10),
      runs: 1,
      tokens: 20,
      cost: 0,
    })
    const created = await api(h, 'POST', `/v1/projects/${projectId}/tickets`, {
      cookie: alice.cookie,
      body: { title: '超预算', body: '应该被拒绝入队。' },
    })
    expect(created.status).toBe(201)
    expect(created.json.warning).toContain('预算')
    const queued = await h.ctx.db.select().from(runs).where(eq(runs.projectId, projectId))
    expect(queued).toHaveLength(0)
  })
})
