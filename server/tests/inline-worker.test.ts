import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { api, createHarness, cookieOf, type Harness } from './helpers/app.js'
import { createDbQueue } from '../src/queue/index.js'
import { startInlineWorker, type InlineWorker } from '../src/worker/inline.js'
import { FakeGitOps } from '../src/worker/fake-git.js'
import { FakeRuntime } from '../src/runtime/fake.js'
import { tickets } from '../src/db/schema.js'
import type { WorkerContext } from '../src/worker/pipeline.js'

const harnesses: Harness[] = []
const workers: InlineWorker[] = []
afterEach(async () => {
  while (workers.length > 0) await workers.pop()?.stop()
  while (harnesses.length > 0) await harnesses.pop()?.close()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('inline worker', () => {
  it('completes a queued ticket inside the API process', async () => {
    const h = await createHarness()
    harnesses.push(h)
    const login = await api(h, 'POST', '/v1/auth/dev-login', { body: { name: 'Alice' } })
    const cookie = cookieOf(login)
    const project = await api(h, 'POST', '/v1/projects', { cookie, body: { name: '本地联调项目' } })
    const projectId = project.json.project.id as string
    await api(h, 'POST', `/v1/projects/${projectId}/repo`, {
      cookie,
      body: { installationId: '1', owner: 'demo-org', name: 'hello-world', defaultBranch: 'main' },
    })
    await api(h, 'POST', `/v1/projects/${projectId}/channels`, {
      cookie,
      body: { provider: 'wecom', externalChatId: 'wc_local', name: '企微联调群', config: { autoJoin: false } },
    })
    await api(h, 'PATCH', `/v1/projects/${projectId}`, { cookie, body: { status: 'active' } })
    const created = await api(h, 'POST', `/v1/projects/${projectId}/tickets`, {
      cookie,
      body: { title: '内联 Worker 联调', body: '验证 API 进程内也能完成计划与执行。' },
    })
    const ticketId = created.json.ticket.id as string

    const ctx: WorkerContext = {
      config: h.config,
      db: h.ctx.db,
      log: h.ctx.log,
      now: h.ctx.now,
      queue: createDbQueue(),
      ports: { github: h.ctx.github, git: new FakeGitOps(), runtime: new FakeRuntime({ delayMs: 5 }) },
    }
    workers.push(startInlineWorker(ctx, 'inline-test'))

    let status = ''
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const [ticket] = await h.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
      status = ticket?.status ?? ''
      if (status === 'waiting_review' || status === 'failed') break
      await sleep(150)
    }
    expect(status).toBe('waiting_review')
    const [ticket] = await h.ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(ticket?.prUrl).toContain('github.com/demo-org/hello-world/pull/')
  })
})
