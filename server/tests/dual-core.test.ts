import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { count, eq } from 'drizzle-orm'
import { createHarness, type Harness } from './helpers/app.js'
import { loginWithIdentity } from '../src/services/auth.js'
import { bindChannel, bindRepo, createProject, updateProject } from '../src/services/projects.js'
import { receiveTrigger, approvePlan, stopTicket, markMerged, markClosed, type DualContext } from '../src/dual/engine.js'
import { claimNextTurn } from '../src/dual/sessions.js'
import { executeTurn, type DualWorkerContext } from '../src/dual/worker.js'
import { FakeGitOps } from '../src/worker/fake-git.js'
import { FakeTurnRuntime } from '../src/dual/runtime.js'
import { evaluations, mandates, reports, sessionTurns, ticketInputs, ticketSubscriptions, tickets } from '../src/db/schema.js'
import { createDbQueue } from '../src/queue/index.js'

const harnesses: Harness[] = []
const tempDirs: string[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function seed(policy: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dual-core-'))
  tempDirs.push(dir)
  const h = await createHarness({ WORKSPACES_DIR: dir, ...(Object.keys(policy).length ? {} : {}) })
  harnesses.push(h)
  const alice = await loginWithIdentity(h.ctx, 'feishu', { externalId: 'ou_alice', name: 'Alice' })
  const bob = await loginWithIdentity(h.ctx, 'feishu', { externalId: 'ou_bob', name: 'Bob' })
  const project = await createProject(h.ctx, alice, { name: '双 Agent 项目', policy })
  await bindRepo(h.ctx, project.id, alice, { installationId: '1', owner: 'demo-org', name: 'hello-world', defaultBranch: 'main' })
  await bindChannel(h.ctx, project.id, alice, { provider: 'feishu', externalChatId: 'oc_dual', name: '双 Agent 群' })
  await updateProject(h.ctx, project.id, alice, { status: 'active' })
  const ctx: DualWorkerContext = {
    ...h.ctx,
    queue: createDbQueue(),
    ports: { github: h.ctx.github, git: new FakeGitOps(), runtime: new FakeTurnRuntime({ delayMs: 1 }) },
  }
  return { h, ctx, alice, bob, project }
}

async function trigger(ctx: DualWorkerContext, overrides: Partial<Parameters<typeof receiveTrigger>[1]> = {}) {
  return receiveTrigger(ctx, {
    provider: 'feishu',
    externalId: `evt_${Math.random().toString(36).slice(2)}`,
    chatId: 'oc_dual',
    threadKey: 'om_root',
    senderExternalId: 'ou_alice',
    senderName: 'Alice',
    text: '@_user_1 修复登录页报错',
    mentionBot: true,
    ...overrides,
  })
}

async function drain(ctx: DualWorkerContext, max = 10) {
  const turns: string[] = []
  for (let index = 0; index < max; index += 1) {
    const turn = await claimNextTurn(ctx, 'dual-test-worker')
    if (!turn) break
    turns.push(turn.id)
    await executeTurn(ctx, turn)
  }
  return turns
}

describe('dual-agent core', () => {
  it('routes a mention through the Main Session into an Executor Session and a PR report', async () => {
    const { ctx, project } = await seed()
    const received = await trigger(ctx)
    expect(received.action).toBe('evaluation')
    expect(await ctx.db.select().from(evaluations)).toHaveLength(1)

    const turns = await drain(ctx)
    expect(turns.length).toBe(2)
    const ticket = (await ctx.db.select().from(tickets))[0]
    expect(ticket?.status).toBe('waiting_review')
    expect(ticket?.stage).toBe('review')
    expect(ticket?.prUrl).toContain('github.com/demo-org/hello-world/pull/')
    expect((await ctx.db.select().from(mandates))[0]?.strength).toBe('explicit')
    expect(await ctx.db.select().from(ticketSubscriptions)).toHaveLength(1)
    expect((await ctx.db.select().from(reports))[0]?.status).toBe('ready')
    expect(await ctx.db.select().from(sessionTurns)).toHaveLength(2)
    expect((await ctx.db.select().from(ticketInputs))).toHaveLength(0)
    expect(ticket?.projectId).toBe(project.id)
  })

  it('gates execution on plan approval and resumes through an approval Input', async () => {
    const { ctx, alice, project } = await seed({ planApproval: 'required' })
    await trigger(ctx)
    const turns = await drain(ctx, 4)
    expect(turns.length).toBe(2)
    let ticket = (await ctx.db.select().from(tickets))[0]
    expect(ticket?.stage).toBe('plan_review')
    expect(ticket?.status).toBe('planned')
    expect(ticket?.plan).toContain('阅读仓库')
    expect(ticket?.prUrl).toBeNull()

    await approvePlan(ctx, project.id, ticket!.id, { id: alice.id, name: alice.name })
    const after = await drain(ctx, 4)
    expect(after.length).toBe(1)
    ticket = (await ctx.db.select().from(tickets))[0]
    expect(ticket?.stage).toBe('review')
    expect(ticket?.status).toBe('waiting_review')
    expect(ticket?.prUrl).toContain('/pull/')
  })

  it('delivers thread follow-ups as Inputs without a new Eval, and resumes an ended ticket', async () => {
    const { ctx } = await seed()
    await trigger(ctx)
    await drain(ctx)
    const [ticket] = await ctx.db.select().from(tickets)
    const evaluationCount = Number((await ctx.db.select({ value: count() }).from(evaluations))[0]?.value ?? 0)

    const followUp = await trigger(ctx, {
      externalId: 'evt_followup',
      text: '请把文案改成中文',
      mentionBot: false,
      threadKey: 'om_root',
    })
    expect(followUp.action).toBe('input')
    expect(Number((await ctx.db.select({ value: count() }).from(evaluations))[0]?.value ?? 0)).toBe(evaluationCount)
    expect(await ctx.db.select().from(ticketInputs)).toHaveLength(1)
    await drain(ctx)
    expect((await ctx.db.select().from(tickets))[0]?.stage).toBe('review')

    await markMerged(ctx, ticket!.id, ticket!.prUrl)
    expect((await ctx.db.select().from(tickets))[0]?.status).toBe('done')
    const resumed = await trigger(ctx, { externalId: 'evt_resume', text: '再补充一个测试', mentionBot: false, threadKey: 'om_root' })
    expect(resumed.action).toBe('input')
    const after = await drain(ctx)
    expect(after.length).toBe(1)
    expect((await ctx.db.select().from(tickets))[0]?.stage).toBe('review')
  })

  it('ignores non-members and dedupes provider events', async () => {
    const { ctx } = await seed()
    const outsider = await trigger(ctx, { externalId: 'evt_outsider', senderExternalId: 'ou_unknown', senderName: 'Unknown' })
    expect(outsider.action).toBe('ignored')
    expect(outsider.reason).toBe('not_member')
    expect(await ctx.db.select().from(evaluations)).toHaveLength(0)

    const first = await trigger(ctx, { externalId: 'evt_dup' })
    const second = await trigger(ctx, { externalId: 'evt_dup' })
    expect(first.action).toBe('evaluation')
    expect(second.action).toBe('duplicate')
    expect(await ctx.db.select().from(evaluations)).toHaveLength(1)
  })

  it('does not resume a stopped ticket and marks PR closes as cancelled', async () => {
    const { ctx, alice, project } = await seed()
    await trigger(ctx)
    await drain(ctx)
    const [ticket] = await ctx.db.select().from(tickets)
    await stopTicket(ctx, project.id, ticket!.id, { id: alice.id, name: alice.name }, 'test stop')
    expect((await ctx.db.select().from(tickets))[0]?.stage).toBe('cancelled')
    expect((await ctx.db.select().from(mandates))[0]?.revokedAt).not.toBeNull()
    const result = await trigger(ctx, { externalId: 'evt_after_stop', mentionBot: false, threadKey: 'om_root', text: '还要改' })
    expect(result.action).toBe('input')
    expect(await claimNextTurn(ctx, 'dual-test-worker')).toBeNull()

    await markClosed(ctx, ticket!.id, ticket!.prUrl)
    expect((await ctx.db.select().from(tickets))[0]?.stage).toBe('cancelled')
  })
})
