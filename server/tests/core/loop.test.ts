import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { openTestDatabase } from '../helpers/db.js'
import type { DatabaseHandle } from '../../src/db/client.js'
import { channels, projects, sessionTurns, tickets, users } from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY } from '../../src/domain/policy.js'
import { receiveCoreTrigger } from '../../src/core/intake.js'
import { RuleBasedRouterModel } from '../../src/core/router/model.js'
import { FakeExecutor } from '../../src/core/worker/fake-executor.js'
import { startCoreLoop } from '../../src/core/worker/loop.js'

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
  return { projectId, channelId }
}

describe('core loop', () => {
  it('routes a pending message and dispatches the queued turn', async () => {
    const { projectId, channelId } = await seed()
    await receiveCoreTrigger(handle.db, {
      projectId,
      channelId,
      provider: 'feishu',
      externalId: `msg-${newId()}`,
      threadKey: 'thread-loop',
      actorExternalId: 'ou_alice',
      actorName: 'Alice',
      text: '修复登录页',
      address: 'mention',
      at: new Date('2026-11-22T00:00:00Z'),
    })

    const loop = startCoreLoop({
      db: handle.db,
      model: new RuleBasedRouterModel(),
      executor: new FakeExecutor(() => ({ status: 'ready', summary: 'loop done', changedFiles: ['a.ts'] })),
      now: () => new Date('2026-11-22T00:00:01Z'),
      intervalMs: 20,
    })

    try {
      let stored: typeof tickets.$inferSelect | undefined
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const [row] = await handle.db.select().from(tickets).where(eq(tickets.projectId, projectId))
        stored = row
        if (stored !== undefined) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(stored?.stage).toBe('review')
      const turns = await handle.db.select().from(sessionTurns).where(eq(sessionTurns.projectId, projectId))
      expect(turns.some((turn) => turn.status === 'succeeded')).toBe(true)
    } finally {
      await loop.stop()
    }
  })
})
