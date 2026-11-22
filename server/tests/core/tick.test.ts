import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { openTestDatabase } from '../helpers/db.js'
import type { DatabaseHandle } from '../../src/db/client.js'
import { channels, projects, tickets, users } from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY } from '../../src/domain/policy.js'
import { receiveCoreTrigger } from '../../src/core/intake.js'
import { coreTick } from '../../src/core/worker/tick.js'
import type { RouterDecisionContext, RouterModel } from '../../src/core/router/model.js'
import type { RouterOutput } from '../../src/core/domain/types.js'

let handle: DatabaseHandle

beforeAll(async () => {
  handle = await openTestDatabase()
})

afterAll(async () => {
  await handle.close()
})

class FakeModel implements RouterModel {
  readonly name = 'fake'
  calls = 0
  constructor(private readonly next: (context: RouterDecisionContext) => RouterOutput | Promise<RouterOutput>) {}
  async decide(context: RouterDecisionContext): Promise<RouterOutput> {
    this.calls += 1
    return this.next(context)
  }
}

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
  return { projectId, channelId }
}

async function enqueue(projectId: string, channelId: string, threadKey: string, text: string) {
  return receiveCoreTrigger(handle.db, {
    projectId,
    channelId,
    provider: 'feishu',
    externalId: `msg-${newId()}`,
    threadKey,
    actorExternalId: 'ou_alice',
    actorName: 'Alice',
    text,
    address: 'mention',
    at: new Date('2026-11-22T00:00:00Z'),
  })
}

function newDecisions(context: RouterDecisionContext): RouterOutput {
  return {
    summary: 'new tickets',
    items: context.batch.map((trigger) => ({
      triggerId: trigger.id,
      action: 'new',
      title: `task ${trigger.id.slice(0, 4)}`,
      reason: 'task',
    })),
  }
}

describe('core tick', () => {
  it('routes every pending thread and creates tickets', async () => {
    const { projectId, channelId } = await seed()
    await enqueue(projectId, channelId, 'thread-a', '修复 A')
    await enqueue(projectId, channelId, 'thread-b', '修复 B')
    const model = new FakeModel(newDecisions)
    let index = 0

    const result = await coreTick({
      db: handle.db,
      model,
      now: () => new Date('2026-11-22T00:01:00Z'),
      shortName: () => `t-tick${String(index += 1).padStart(2, '0')}`,
    })

    expect(result.threads).toBe(2)
    expect(result.tickets).toBe(2)
    expect(result.errors).toBe(0)
    expect(await handle.db.select().from(tickets).where(eq(tickets.projectId, projectId))).toHaveLength(2)
  })

  it('continues with later threads when one Router batch fails validation', async () => {
    const { projectId, channelId } = await seed()
    await enqueue(projectId, channelId, 'thread-bad', '坏输出')
    await enqueue(projectId, channelId, 'thread-good', '好输出')
    let calls = 0
    const model = new FakeModel((context) => {
      calls += 1
      if (calls === 1) return { summary: 'bad', items: [] }
      return newDecisions(context)
    })

    const result = await coreTick({
      db: handle.db,
      model,
      now: () => new Date('2026-11-22T00:02:00Z'),
      shortName: () => `t-good${String(calls).padStart(2, '0')}`,
    })

    expect(result.errors).toBe(1)
    expect(result.tickets).toBe(1)
    expect(await handle.db.select().from(tickets).where(eq(tickets.projectId, projectId))).toHaveLength(1)
  })

  it('returns zeros when nothing is pending', async () => {
    const result = await coreTick({
      db: handle.db,
      model: new FakeModel(newDecisions),
      now: () => new Date('2026-11-22T00:03:00Z'),
    })
    expect(result).toEqual({ threads: 0, runs: 0, tickets: 0, turns: 0, errors: 0 })
  })
})
