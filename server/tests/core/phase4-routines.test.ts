import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { api, cookieOf, createHarness, type Harness } from '../helpers/app.js'
import { nextCronDate, parseCronExpression } from '../../src/core/routines/cron.js'
import { tickRoutines } from '../../src/core/routines/scheduler.js'
import { RuleBasedRouterModel } from '../../src/core/router/model.js'
import { dispatchOnce } from '../../src/core/worker/dispatcher.js'
import { coreTick } from '../../src/core/worker/tick.js'
import { bots, outboxEvents, rooms, routines, tickets, triggers } from '../../src/db/schema.js'
import { handleGithubWebhook } from '../../src/services/github-webhooks.js'

const harnesses: Harness[] = []
const dirs: string[] = []

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('Phase 4: 7x24 Routines (Cron, Repo Events, Manual Run & Quiet-When-Clean)', () => {
  it('parses standard 5-field cron expressions and computes timezone-aware next run times', () => {
    const parsed = parseCronExpression('*/15 9-18 * * 1-5')
    expect(parsed.minutes.has(0)).toBe(true)
    expect(parsed.minutes.has(45)).toBe(true)
    expect(parsed.daysOfWeek.has(1)).toBe(true)
    expect(parsed.daysOfWeek.has(0)).toBe(false)

    // 2026-11-27 00:10:00Z is 08:10:00 Asia/Shanghai (Friday)
    const from = new Date('2026-11-27T00:10:00.000Z')
    const next15 = nextCronDate('*/15 * * * *', from, 'UTC')
    expect(next15.toISOString()).toBe('2026-11-27T00:15:00.000Z')

    // 09:30 Asia/Shanghai on 2026-11-27 is 01:30:00Z
    const nextMorning = nextCronDate('30 9 * * 1-5', from, 'Asia/Shanghai')
    expect(nextMorning.toISOString()).toBe('2026-11-27T01:30:00.000Z')

    expect(() => parseCronExpression('invalid cron')).toThrow()
  })

  it('claims due cron routines idempotently, executes them, and suppresses noisy IM output when quiet-and-clean', async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'sa-phase4-'))
    dirs.push(workDir)
    let clock = new Date('2026-11-27T01:00:00.000Z')
    const h = await createHarness({ WORKSPACES_DIR: workDir })
    h.ctx.now = () => clock
    harnesses.push(h)

    const login = await api(h, 'POST', '/v1/auth/dev-login', { body: { name: 'RoutineOwner' } })
    const cookie = cookieOf(login)
    const projRes = await api(h, 'POST', '/v1/projects', { cookie, body: { name: 'Routine Lab' } })
    const projectId = projRes.json.project.id as string

    await api(h, 'POST', `/v1/projects/${projectId}/bots/templates/rd`, { cookie, body: {} })
    const chanRes = await api(h, 'POST', `/v1/projects/${projectId}/channels`, {
      cookie,
      body: { provider: 'feishu', externalChatId: 'oc_routine_test', name: '巡检群' },
    })
    const channelId = chanRes.json.channel.id as string
    const roomsRes = await api(h, 'GET', `/v1/projects/${projectId}/rooms`, { cookie })
    const roomId = roomsRes.json.items[0].id as string
    await h.ctx.db.update(rooms).set({ channelId }).where(eq(rooms.id, roomId))
    const projectBots = await h.ctx.db.select().from(bots).where(eq(bots.projectId, projectId))
    const qaBot = projectBots.find((b) => b.slug === 'qa')!

    const createRes = await api(h, 'POST', `/v1/projects/${projectId}/routines`, {
      cookie,
      body: {
        name: '每 15 分钟健康巡检',
        botId: qaBot.id,
        roomId,
        triggerType: 'cron',
        cronExpr: '*/15 * * * *',
        timezone: 'UTC',
        prompt: '检查服务健康度',
        notifyOnQuiet: false,
      },
    })
    expect(createRes.status).toBe(201)
    const routineId = createRes.json.routine.id as string
    expect(new Date(createRes.json.routine.nextRunAt).toISOString()).toBe('2026-11-27T01:15:00.000Z')

    // Not due yet at 01:10Z
    clock = new Date('2026-11-27T01:10:00.000Z')
    expect((await tickRoutines({ db: h.ctx.db, now: () => clock })).triggered).toBe(0)

    // Due at 01:15Z!
    clock = new Date('2026-11-27T01:15:00.000Z')
    expect((await tickRoutines({ db: h.ctx.db, now: () => clock })).triggered).toBe(1)
    // Immediate re-tick does NOT double-trigger; nextRunAt moved to 01:30Z
    expect((await tickRoutines({ db: h.ctx.db, now: () => clock })).triggered).toBe(0)
    const [afterTick] = await h.ctx.db.select().from(routines).where(eq(routines.id, routineId))
    expect(afterTick?.nextRunAt?.toISOString()).toBe('2026-11-27T01:30:00.000Z')

    // Route & execute with a clean summary -> IM outbox stays completely quiet!
    await coreTick({ db: h.ctx.db, model: new RuleBasedRouterModel(), now: () => clock })
    const ran = await dispatchOnce({
      db: h.ctx.db,
      executor: {
        kind: 'fake',
        async run() {
          return { status: 'ready', summary: '健康检查通过，一切正常。', tokens: 40, cost: 0 }
        },
      },
      now: () => clock,
      worktreeRoot: workDir,
    })
    expect(ran).toBe(true)

    const [updatedRoutine] = await h.ctx.db.select().from(routines).where(eq(routines.id, routineId))
    expect(updatedRoutine?.lastStatus).toBe('ready')
    expect(updatedRoutine?.lastTicketId).toBeTruthy()
    const [routineTicket] = await h.ctx.db.select().from(tickets).where(eq(tickets.id, updatedRoutine!.lastTicketId!))
    expect(routineTicket?.routineId).toBe(routineId)

    const outbox = await h.ctx.db.select().from(outboxEvents).where(eq(outboxEvents.projectId, projectId))
    expect(outbox.length).toBe(0)
  })

  it('supports manual试跑 and GitHub repo_event webhook triggers with branch filtering', async () => {
    const h = await createHarness()
    harnesses.push(h)

    const login = await api(h, 'POST', '/v1/auth/dev-login', { body: { name: 'DevOps' } })
    const cookie = cookieOf(login)
    const projRes = await api(h, 'POST', '/v1/projects', { cookie, body: { name: 'Event Routine Proj' } })
    const projectId = projRes.json.project.id as string
    await api(h, 'POST', `/v1/projects/${projectId}/repo`, {
      cookie,
      body: { installationId: '1', owner: 'acme', name: 'api', defaultBranch: 'main' },
    })

    const createRes = await api(h, 'POST', `/v1/projects/${projectId}/routines`, {
      cookie,
      body: {
        name: 'Main 分支 Push 巡检',
        triggerType: 'repo_event',
        eventFilter: { events: ['push'], branches: ['main'] },
        prompt: '检查 main 分支最新提交的变更风险',
      },
    })
    expect(createRes.status).toBe(201)
    const routineId = createRes.json.routine.id as string

    // Manual trigger
    const manualRes = await api(h, 'POST', `/v1/projects/${projectId}/routines/${routineId}/run`, {
      cookie,
      body: {},
    })
    expect(manualRes.status).toBe(200)
    expect(manualRes.json.triggerId).toBeTruthy()

    // Non-matching branch push should be ignored
    const ignoreRes = await handleGithubWebhook(
      h.ctx,
      'push',
      { ref: 'refs/heads/feature/wip', repository: { full_name: 'acme/api' } },
      'deliv-feature-1',
    )
    expect(ignoreRes.handled).toBe('ignored')

    // Matching main branch push triggers the repo_event routine!
    const triggerRes = await handleGithubWebhook(
      h.ctx,
      'push',
      { ref: 'refs/heads/main', repository: { full_name: 'acme/api' } },
      'deliv-main-1',
    )
    expect(triggerRes.handled).toBe('routine-triggered')

    const routineTriggers = await h.ctx.db.select().from(triggers).where(eq(triggers.projectId, projectId))
    expect(routineTriggers.filter((t) => t.kind === 'routine').length).toBe(2)
  })
})
