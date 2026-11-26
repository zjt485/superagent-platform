import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { api, cookieOf, createHarness, type Harness } from '../helpers/app.js'
import { bots, roomMessages, tickets } from '../../src/db/schema.js'
import { coreTick } from '../../src/core/worker/tick.js'
import { dispatchOnce } from '../../src/core/worker/dispatcher.js'
import { FakeExecutor } from '../../src/core/worker/fake-executor.js'
import { RuleBasedRouterModel } from '../../src/core/router/model.js'
import { createEventBus, type ProjectStreamEvent } from '../../src/services/events.js'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close()
})

async function login(h: Harness, name: string) {
  const res = await api(h, 'POST', '/v1/auth/dev-login', { body: { name } })
  expect(res.status).toBe(200)
  return { cookie: cookieOf(res), user: res.json.user as { id: string; name: string } }
}

describe('Phase 1: Bot Roster, Rooms, Multi-Bot Handoff & SSE', () => {
  it('installs the 4-bot R&D template, routes @mentions in a Room, executes multi-bot handoff, and enforces maxHops', async () => {
    const h = await createHarness()
    harnesses.push(h)
    const bus = createEventBus()
    h.ctx.events = bus

    const alice = await login(h, 'Alice')
    const created = await api(h, 'POST', '/v1/projects', {
      cookie: alice.cookie,
      body: { name: '产研数字员工项目' },
    })
    expect(created.status).toBe(201)
    const projectId = created.json.project.id as string

    const streamEvents: ProjectStreamEvent[] = []
    const unsubscribe = bus.subscribe(projectId, (event) => streamEvents.push(event))

    // One-click install 4-role R&D squad.
    const squad = await api(h, 'POST', `/v1/projects/${projectId}/bots/templates/rd`, {
      cookie: alice.cookie,
      body: {},
    })
    expect(squad.status).toBe(201)
    expect(squad.json.items).toHaveLength(4)
    expect(squad.json.items.map((b: { slug: string }) => b.slug).sort()).toEqual(['engineer', 'pm', 'qa', 'researcher'])

    // Default main group room exists with all 4 bots.
    const roomsRes = await api(h, 'GET', `/v1/projects/${projectId}/rooms`, { cookie: alice.cookie })
    expect(roomsRes.status).toBe(200)
    expect(roomsRes.json.items).toHaveLength(1)
    const mainRoom = roomsRes.json.items[0] as { id: string; bots: Array<{ id: string; slug: string }> }
    expect(mainRoom.bots).toHaveLength(4)

    // Set maxHandoffHops = 1 to test both a successful hop (0 -> 1) and loop cutoff (1 -> 2 blocked).
    const patchRoom = await api(h, 'PATCH', `/v1/projects/${projectId}/rooms/${mainRoom.id}`, {
      cookie: alice.cookie,
      body: { maxHandoffHops: 1 },
    })
    expect(patchRoom.status).toBe(200)

    // Human posts @researcher task in the Room.
    const posted = await api(h, 'POST', `/v1/projects/${projectId}/rooms/${mainRoom.id}/messages`, {
      cookie: alice.cookie,
      body: { content: '@researcher 调研竞品登录页体验并给工程落地方案' },
    })
    expect(posted.status).toBe(201)
    expect(posted.json.triggerId).toBeTruthy()

    // Tick 1: Router creates ticket assigned to @researcher.
    const tick1 = await coreTick({ db: h.ctx.db, model: new RuleBasedRouterModel(), now: h.ctx.now })
    expect(tick1.tickets).toBe(1)

    const [firstTicket] = await h.ctx.db.select().from(tickets).where(eq(tickets.projectId, projectId))
    const [researcher] = await h.ctx.db.select().from(bots).where(eq(bots.slug, 'researcher'))
    const [engineer] = await h.ctx.db.select().from(bots).where(eq(bots.slug, 'engineer'))
    expect(firstTicket?.botId).toBe(researcher?.id)
    expect(firstTicket?.roomId).toBe(mainRoom.id)
    expect(firstTicket?.handoffHop).toBe(0)

    // Turn 1: @researcher finishes and hands off to @engineer (hop 0 -> 1, allowed).
    await dispatchOnce({
      db: h.ctx.db,
      events: bus,
      now: h.ctx.now,
      executor: new FakeExecutor(() => ({
        status: 'ready',
        summary: '已完成竞品登录页调研报告。',
        handoff: {
          toBotSlug: 'engineer',
          summary: '请按调研报告优化登录页超时与错误提示',
          context: '建议超时改 30 秒，并显示明确错误码。',
        },
      })),
    })

    // Tick 2: Router routes the handoff trigger to @engineer.
    const tick2 = await coreTick({ db: h.ctx.db, model: new RuleBasedRouterModel(), now: h.ctx.now })
    expect(tick2.tickets).toBe(1)

    const allTickets = await h.ctx.db.select().from(tickets).where(eq(tickets.projectId, projectId))
    expect(allTickets).toHaveLength(2)
    const engTicket = allTickets.find((t) => t.botId === engineer?.id)
    expect(engTicket?.handoffHop).toBe(1)

    // Turn 2: @engineer tries to hand off to @qa (hop 1 -> 2 > maxHandoffHops=1 -> blocked!).
    await dispatchOnce({
      db: h.ctx.db,
      events: bus,
      now: h.ctx.now,
      executor: new FakeExecutor(() => ({
        status: 'ready',
        summary: '已完成代码修改。',
        handoff: {
          toBotSlug: 'qa',
          summary: '请做回归测试',
          context: '检查登录页超时逻辑',
        },
      })),
    })

    const [updatedEngTicket] = await h.ctx.db.select().from(tickets).where(eq(tickets.id, engTicket!.id))
    expect(updatedEngTicket?.stage).toBe('blocked')

    // Room timeline contains user message, handoff card, and bot reports.
    const msgsRes = await api(h, 'GET', `/v1/projects/${projectId}/rooms/${mainRoom.id}/messages`, { cookie: alice.cookie })
    expect(msgsRes.status).toBe(200)
    const kinds = msgsRes.json.items.map((m: { kind: string }) => m.kind)
    expect(kinds).toContain('chat')
    expect(kinds).toContain('handoff')
    expect(kinds).toContain('report')
    expect(msgsRes.json.items.some((m: { content: string }) => m.content.includes('最大跳数上限'))).toBe(true)

    // SSE stream received room.message, bot.status, and ticket.updated events.
    expect(streamEvents.some((e) => e.type === 'room.message')).toBe(true)
    expect(streamEvents.some((e) => e.type === 'bot.status')).toBe(true)
    expect(streamEvents.some((e) => e.type === 'ticket.updated')).toBe(true)

    // Opening a DM with @qa reuses the same DM room idempotently.
    const [qa] = await h.ctx.db.select().from(bots).where(eq(bots.slug, 'qa'))
    const dm1 = await api(h, 'POST', `/v1/projects/${projectId}/rooms`, {
      cookie: alice.cookie,
      body: { kind: 'dm', defaultBotId: qa!.id },
    })
    const dm2 = await api(h, 'POST', `/v1/projects/${projectId}/rooms`, {
      cookie: alice.cookie,
      body: { kind: 'dm', defaultBotId: qa!.id },
    })
    expect(dm1.status).toBe(201)
    expect(dm2.json.room.id).toBe(dm1.json.room.id)
    expect((await h.ctx.db.select().from(roomMessages).where(eq(roomMessages.roomId, mainRoom.id))).length).toBeGreaterThanOrEqual(4)
    unsubscribe()
  })
})
