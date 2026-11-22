import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { createHarness } from '../helpers/app.js'
import type { DualContext } from '../../src/dual/engine.js'
import { ingestInboundEvent } from '../../src/services/intake.js'
import {
  channels,
  identities,
  projectMembers,
  projects,
  tickets,
  triggers,
  users,
} from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY } from '../../src/domain/policy.js'
import { coreTick } from '../../src/core/worker/tick.js'
import { RuleBasedRouterModel } from '../../src/core/router/model.js'
import type { InboundEvent } from '../../src/domain/message.js'

async function seed(harness: Awaited<ReturnType<typeof createHarness>>) {
  const userId = newId()
  const projectId = newId()
  const channelId = newId()
  await harness.ctx.db.insert(users).values({ id: userId, name: 'Alice' })
  await harness.ctx.db.insert(identities).values({
    id: newId(),
    userId,
    provider: 'feishu',
    externalId: 'ou_alice',
    displayName: 'Alice',
  })
  await harness.ctx.db.insert(projects).values({
    id: projectId,
    name: 'Demo',
    slug: `demo-${projectId.slice(0, 8)}`,
    ownerId: userId,
    status: 'active',
    policyJson: DEFAULT_POLICY,
    modelConfig: DEFAULT_MODEL_CONFIG,
  })
  await harness.ctx.db.insert(projectMembers).values({
    id: newId(),
    projectId,
    userId,
    role: 'owner',
  })
  await harness.ctx.db.insert(channels).values({
    id: channelId,
    projectId,
    provider: 'feishu',
    externalChatId: 'chat-core',
    status: 'active',
    config: {},
  })
  return { projectId, channelId }
}

function event(): InboundEvent {
  return {
    provider: 'feishu',
    deliveryId: 'delivery-1',
    eventType: 'im.message.receive_v1',
    messages: [
      {
        provider: 'feishu',
        providerMessageId: 'message-core-1',
        externalChatId: 'chat-core',
        threadKey: 'thread-core',
        sender: { externalId: 'ou_alice', name: 'Alice' },
        text: '修复登录页',
        mentionBot: true,
      },
    ],
  }
}

describe('core intake service', () => {
  it('routes a Feishu message into the core router and creates a ticket on tick', async () => {
    const harness = await createHarness({ CORE_ENABLED: true })
    const { projectId } = await seed(harness)

    const results = await ingestInboundEvent(harness.ctx as unknown as DualContext, event())
    expect(results[0]?.action).toBe('trigger_evaluated')

    const triggerRows = await harness.ctx.db.select().from(triggers).where(eq(triggers.projectId, projectId))
    expect(triggerRows).toHaveLength(1)
    expect(triggerRows[0]?.disposition).toBe('pending')

    const tick = await coreTick({
      db: harness.ctx.db,
      model: new RuleBasedRouterModel(),
      now: () => new Date('2026-11-22T00:00:00Z'),
    })
    expect(tick.tickets).toBe(1)
    expect(await harness.ctx.db.select().from(tickets).where(eq(tickets.projectId, projectId))).toHaveLength(1)
    await harness.close()
  })
})
