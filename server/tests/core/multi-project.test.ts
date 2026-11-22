import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { openTestDatabase } from '../helpers/db.js'
import type { DatabaseHandle } from '../../src/db/client.js'
import { channels, projects, tickets, users } from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY } from '../../src/domain/policy.js'
import { receiveCoreTrigger } from '../../src/core/intake.js'
import { RuleBasedRouterModel } from '../../src/core/router/model.js'
import { coreTick } from '../../src/core/worker/tick.js'

let handle: DatabaseHandle

beforeAll(async () => {
  handle = await openTestDatabase()
})

afterAll(async () => {
  await handle.close()
})

async function seedProject(name: string) {
  const userId = newId()
  const projectId = newId()
  const channelId = newId()
  await handle.db.insert(users).values({ id: userId, name: `${name} owner` })
  await handle.db.insert(projects).values({
    id: projectId,
    name,
    slug: `${name.toLowerCase()}-${projectId.slice(0, 8)}`,
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

describe('multiple projects', () => {
  it('routes and isolates the same thread key across two projects', async () => {
    const first = await seedProject('Alpha')
    const second = await seedProject('Beta')
    for (const [index, project] of [first, second].entries()) {
      await receiveCoreTrigger(handle.db, {
        projectId: project.projectId,
        channelId: project.channelId,
        provider: 'feishu',
        externalId: `msg-multi-${index}`,
        threadKey: 'same-thread',
        actorExternalId: 'ou_alice',
        actorName: 'Alice',
        text: `修复 ${index}`,
        address: 'mention',
        at: new Date('2026-11-22T00:00:00Z'),
      })
    }

    const result = await coreTick({
      db: handle.db,
      model: new RuleBasedRouterModel(),
      now: () => new Date('2026-11-22T00:01:00Z'),
    })
    expect(result.tickets).toBe(2)

    const alpha = await handle.db.select().from(tickets).where(eq(tickets.projectId, first.projectId))
    const beta = await handle.db.select().from(tickets).where(eq(tickets.projectId, second.projectId))
    expect(alpha).toHaveLength(1)
    expect(beta).toHaveLength(1)
    expect(alpha[0]?.title).toContain('修复 0')
    expect(beta[0]?.title).toContain('修复 1')
  })
})
