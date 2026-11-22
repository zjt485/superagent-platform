import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { openTestDatabase } from '../helpers/db.js'
import type { DatabaseHandle } from '../../src/db/client.js'
import {
  channels,
  decisions,
  evaluations,
  projects,
  tickets,
  users,
} from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY } from '../../src/domain/policy.js'
import { insertTrigger, getTrigger } from '../../src/core/store/triggers.js'
import { getThread, markThreadPending, touchThread } from '../../src/core/store/threads.js'
import { flushThread } from '../../src/core/router/flush.js'
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

async function seedThread(threadKey: string) {
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
  const at = new Date('2026-11-22T00:00:00Z')
  await touchThread(handle.db, { projectId, channelId, threadKey, at })
  await markThreadPending(handle.db, { projectId, channelId, threadKey }, at)
  const thread = await getThread(handle.db, { projectId, channelId, threadKey })
  const [project] = await handle.db.select().from(projects).where(eq(projects.id, projectId))
  if (thread === undefined || project === undefined) throw new Error('seed failed')
  return { projectId, channelId, thread, project }
}

async function addTrigger(projectId: string, channelId: string, threadKey: string, text: string) {
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
  return id
}

describe('flush thread', () => {
  it('runs the model once, applies decisions and releases the thread', async () => {
    const { projectId, channelId, thread, project } = await seedThread('thread-flush')
    const triggerId = await addTrigger(projectId, channelId, 'thread-flush', '修复登录页')
    const model = new FakeModel(() => ({
      summary: 'created one ticket',
      items: [{ triggerId, action: 'new', title: '修复登录页', reason: 'task' }],
    }))

    const result = await flushThread({
      db: handle.db,
      project,
      thread,
      model,
      policyVersion: 'v1',
      at: new Date('2026-11-22T00:01:00Z'),
      shortName: () => 't-flush1',
    })

    expect(model.calls).toBe(1)
    expect(result.ticketIds).toHaveLength(1)
    expect(await handle.db.select().from(tickets).where(eq(tickets.projectId, projectId))).toHaveLength(1)
    const run = await handle.db.select().from(evaluations).where(eq(evaluations.id, result.runId!))
    expect(run[0]?.status).toBe('decided')
    expect(run[0]?.summary).toBe('created one ticket')
    const refreshed = await getThread(handle.db, { projectId, channelId, threadKey: 'thread-flush' })
    expect(refreshed?.routerPending).toBe(false)
    expect(refreshed?.summary).toBe('created one ticket')
    expect(await handle.db.select().from(decisions).where(eq(decisions.projectId, projectId))).toHaveLength(1)
  })

  it('marks the batch pending_review when the model output is invalid', async () => {
    const { projectId, channelId, thread, project } = await seedThread('thread-bad')
    const triggerId = await addTrigger(projectId, channelId, 'thread-bad', '修复登录页')
    const model = new FakeModel(() => ({ summary: 'x', items: [] }))

    await expect(
      flushThread({
        db: handle.db,
        project,
        thread,
        model,
        policyVersion: 'v1',
        at: new Date('2026-11-22T00:01:00Z'),
      }),
    ).rejects.toThrow('missing decision')
    expect((await getTrigger(handle.db, triggerId))?.disposition).toBe('pending_review')
    const refreshed = await getThread(handle.db, { projectId, channelId, threadKey: 'thread-bad' })
    expect(refreshed?.routerPending).toBe(false)
  })

  it('does not call the model when there is nothing pending', async () => {
    const { thread, project } = await seedThread('thread-empty')
    const model = new FakeModel(() => ({ summary: 'x', items: [] }))
    const result = await flushThread({
      db: handle.db,
      project,
      thread,
      model,
      policyVersion: 'v1',
      at: new Date('2026-11-22T00:01:00Z'),
    })
    expect(model.calls).toBe(0)
    expect(result.runId).toBeNull()
  })
})
