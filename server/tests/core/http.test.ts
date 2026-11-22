import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { createHarness, api } from '../helpers/app.js'
import { channels, projects, tickets, users } from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY } from '../../src/domain/policy.js'

async function seed(harness: Awaited<ReturnType<typeof createHarness>>) {
  const userId = newId()
  const projectId = newId()
  const channelId = newId()
  await harness.ctx.db.insert(users).values({ id: userId, name: 'Alice' })
  await harness.ctx.db.insert(projects).values({
    id: projectId,
    name: 'Demo',
    slug: `demo-${projectId.slice(0, 8)}`,
    ownerId: userId,
    status: 'active',
    policyJson: DEFAULT_POLICY,
    modelConfig: DEFAULT_MODEL_CONFIG,
  })
  await harness.ctx.db.insert(channels).values({
    id: channelId,
    projectId,
    provider: 'feishu',
    externalChatId: `chat-${channelId.slice(0, 8)}`,
    status: 'active',
    config: {},
  })
  return { projectId, channelId }
}

describe('core internal http', () => {
  it('accepts a trigger and routes it on tick', async () => {
    const harness = await createHarness()
    const { projectId, channelId } = await seed(harness)
    const headers = { authorization: `Bearer ${harness.config.INTERNAL_TOKEN}` }

    const intake = await api(harness, 'POST', '/internal/core/triggers', {
      headers,
      body: {
        projectId,
        channelId,
        provider: 'feishu',
        externalId: 'msg-http-1',
        threadKey: 'thread-http',
        actorName: 'Alice',
        text: '修复登录页',
        address: 'mention',
      },
    })
    expect(intake.status).toBe(200)
    expect(intake.json.action).toBe('queued')

    const tick = await api(harness, 'POST', '/internal/core/tick', { headers })
    expect(tick.status).toBe(200)
    expect(tick.json.tickets).toBe(1)
    expect(await harness.ctx.db.select().from(tickets).where(eq(tickets.projectId, projectId))).toHaveLength(1)
    await harness.close()
  })

  it('rejects a missing internal token', async () => {
    const harness = await createHarness()
    const response = await api(harness, 'POST', '/internal/core/tick', { body: {} })
    expect(response.status).toBe(401)
    await harness.close()
  })
})
