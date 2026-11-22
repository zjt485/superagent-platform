import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { openTestDatabase } from '../helpers/db.js'
import type { DatabaseHandle } from '../../src/db/client.js'
import {
  agentSessions,
  channels,
  decisions,
  evaluations,
  mandates,
  outboxEvents,
  projects,
  sessionTurns,
  ticketInputs,
  ticketSubscriptions,
  tickets,
  triggers,
  users,
} from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY } from '../../src/domain/policy.js'
import { insertTrigger, getTrigger } from '../../src/core/store/triggers.js'
import { applyRouterOutput } from '../../src/core/router/apply.js'

let handle: DatabaseHandle

beforeAll(async () => {
  handle = await openTestDatabase()
})

afterAll(async () => {
  await handle.close()
})

async function seed() {
  const userId = newId()
  const projectId = newId()
  const channelId = newId()
  await handle.db.insert(users).values({ id: userId, name: 'Alice' })
  await handle.db.insert(projects).values({
    id: projectId,
    name: 'Demo',
    slug: `demo-${projectId.slice(0, 8)}`,
    ownerId: userId,
    status: 'active',
    policyJson: DEFAULT_POLICY,
    modelConfig: DEFAULT_MODEL_CONFIG,
  })
  await handle.db.insert(channels).values({
    id: channelId,
    projectId,
    provider: 'feishu',
    externalChatId: `chat-${channelId.slice(0, 8)}`,
    status: 'active',
    config: {},
  })
  return { userId, projectId, channelId }
}

async function addTrigger(projectId: string, channelId: string, text: string, threadKey: string) {
  const id = newId()
  await insertTrigger(handle.db, {
    id,
    projectId,
    channelId,
    provider: 'feishu',
    externalId: `msg-${id.slice(0, 8)}`,
    threadKey,
    actorExternalId: 'ou_alice',
    actorName: 'Alice',
    text,
    address: 'mention',
    createdAt: new Date('2026-11-22T00:00:00Z'),
  })
  const row = await getTrigger(handle.db, id)
  if (row === undefined) throw new Error('missing trigger')
  return row
}

async function addRun(projectId: string, channelId: string, threadKey: string, triggerIds: string[]) {
  const id = newId()
  await handle.db.insert(evaluations).values({
    id,
    projectId,
    channelId,
    threadKey,
    policyVersion: 'v1',
    status: 'decided',
    triggerIds,
    createdAt: new Date('2026-11-22T00:00:00Z'),
  })
  return id
}

describe('apply router output', () => {
  it('creates a ticket, mandate, subscription, first turn and ack for a new decision', async () => {
    const { projectId, channelId } = await seed()
    const trigger = await addTrigger(projectId, channelId, '修复登录页', 'thread-new')
    const runId = await addRun(projectId, channelId, 'thread-new', [trigger.id])

    const result = await applyRouterOutput(handle.db, {
      projectId,
      channelId,
      threadKey: 'thread-new',
      provider: 'feishu',
      policyVersion: 'v1',
      runId,
      batch: [trigger],
      at: new Date('2026-11-22T00:01:00Z'),
      shortName: () => 't-test01',
      output: {
        summary: 'new',
        items: [{ triggerId: trigger.id, action: 'new', title: '修复登录页', reason: 'task' }],
      },
    })

    expect(result.ticketIds).toHaveLength(1)
    const [ticket] = await handle.db.select().from(tickets).where(eq(tickets.id, result.ticketIds[0]!))
    expect(ticket?.stage).toBe('queued')
    expect(ticket?.shortName).toBe('t-test01')
    expect(ticket?.branch).toBe('agent/t-test01')

    expect(await handle.db.select().from(decisions).where(eq(decisions.projectId, projectId))).toHaveLength(1)
    expect(await handle.db.select().from(mandates).where(eq(mandates.projectId, projectId))).toHaveLength(1)
    expect(await handle.db.select().from(ticketSubscriptions).where(eq(ticketSubscriptions.projectId, projectId))).toHaveLength(1)
    expect(await handle.db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId))).toHaveLength(1)
    expect(await handle.db.select().from(sessionTurns).where(eq(sessionTurns.projectId, projectId))).toHaveLength(1)
    expect(await handle.db.select().from(outboxEvents).where(eq(outboxEvents.projectId, projectId))).toHaveLength(1)
    expect((await getTrigger(handle.db, trigger.id))?.disposition).toBe('new_ticket')
  })

  it('attaches a follow-up to an idle ticket and queues the next turn', async () => {
    const { projectId, channelId } = await seed()
    const first = await addTrigger(projectId, channelId, '修复登录页', 'thread-attach')
    const runId = await addRun(projectId, channelId, 'thread-attach', [first.id])
    const created = await applyRouterOutput(handle.db, {
      projectId,
      channelId,
      threadKey: 'thread-attach',
      provider: 'feishu',
      policyVersion: 'v1',
      runId,
      batch: [first],
      at: new Date('2026-11-22T00:01:00Z'),
      shortName: () => 't-attach',
      output: {
        summary: 'new',
        items: [{ triggerId: first.id, action: 'new', title: '修复登录页', reason: 'task' }],
      },
    })
    const ticketId = created.ticketIds[0]!

    const followUp = await addTrigger(projectId, channelId, '再改成 30 秒', 'thread-attach')
    const run2 = await addRun(projectId, channelId, 'thread-attach', [followUp.id])
    await applyRouterOutput(handle.db, {
      projectId,
      channelId,
      threadKey: 'thread-attach',
      provider: 'feishu',
      policyVersion: 'v1',
      runId: run2,
      batch: [followUp],
      at: new Date('2026-11-22T00:02:00Z'),
      output: {
        summary: 'attach',
        items: [{ triggerId: followUp.id, action: 'attach', ticketId, reason: 'follow-up' }],
      },
    })

    const inputs = await handle.db.select().from(ticketInputs).where(eq(ticketInputs.projectId, projectId))
    expect(inputs).toHaveLength(2)
    const turns = await handle.db.select().from(sessionTurns).where(eq(sessionTurns.ticketId, ticketId))
    expect(turns).toHaveLength(2)
    expect(turns.map((turn) => turn.seq).sort()).toEqual([1, 2])
  })

  it('marks ignored triggers and cancels queued turns for stop', async () => {
    const { projectId, channelId } = await seed()
    const trigger = await addTrigger(projectId, channelId, '哈哈哈', 'thread-stop')
    const runId = await addRun(projectId, channelId, 'thread-stop', [trigger.id])
    await applyRouterOutput(handle.db, {
      projectId,
      channelId,
      threadKey: 'thread-stop',
      provider: 'feishu',
      policyVersion: 'v1',
      runId,
      batch: [trigger],
      at: new Date('2026-11-22T00:01:00Z'),
      output: {
        summary: 'ignore',
        items: [{ triggerId: trigger.id, action: 'ignore', reason: 'chat' }],
      },
    })
    expect((await getTrigger(handle.db, trigger.id))?.disposition).toBe('ignored')

    const newTrigger = await addTrigger(projectId, channelId, '修复登录页', 'thread-stop')
    const created = await applyRouterOutput(handle.db, {
      projectId,
      channelId,
      threadKey: 'thread-stop',
      provider: 'feishu',
      policyVersion: 'v1',
      runId: await addRun(projectId, channelId, 'thread-stop', [newTrigger.id]),
      batch: [newTrigger],
      at: new Date('2026-11-22T00:02:00Z'),
      shortName: () => 't-stop01',
      output: {
        summary: 'new',
        items: [{ triggerId: newTrigger.id, action: 'new', title: '停止我', reason: 'task' }],
      },
    })
    const ticketId = created.ticketIds[0]!
    const stopTrigger = await addTrigger(projectId, channelId, '停一下', 'thread-stop')
    await applyRouterOutput(handle.db, {
      projectId,
      channelId,
      threadKey: 'thread-stop',
      provider: 'feishu',
      policyVersion: 'v1',
      runId: await addRun(projectId, channelId, 'thread-stop', [stopTrigger.id]),
      batch: [stopTrigger],
      at: new Date('2026-11-22T00:03:00Z'),
      output: {
        summary: 'stop',
        items: [{ triggerId: stopTrigger.id, action: 'stop', ticketId, reason: 'asked to stop' }],
      },
    })
    const [ticket] = await handle.db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(ticket?.stage).toBe('cancelled')
    const turns = await handle.db.select().from(sessionTurns).where(eq(sessionTurns.ticketId, ticketId))
    expect(turns.every((turn) => turn.status === 'cancelled')).toBe(true)
  })
})
