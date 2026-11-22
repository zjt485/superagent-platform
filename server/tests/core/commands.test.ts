import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { openTestDatabase } from '../helpers/db.js'
import type { DatabaseHandle } from '../../src/db/client.js'
import {
  channels,
  outboxEvents,
  projects,
  sessionTurns,
  ticketInputs,
  tickets,
  users,
} from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY } from '../../src/domain/policy.js'
import { insertTicket } from '../../src/core/store/tickets.js'
import { handleCoreCommand } from '../../src/core/commands.js'

let handle: DatabaseHandle

beforeAll(async () => {
  handle = await openTestDatabase()
})

afterAll(async () => {
  await handle.close()
})

async function seed(stage: 'plan_review' | 'failed' | 'blocked') {
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
  const ticket = await insertTicket(handle.db, {
    id: newId(),
    projectId,
    channelId,
    threadKey: 'thread-cmd',
    title: 'Fix login',
    body: 'details',
    shortName: 't-cmd001',
    stage,
    at: new Date('2026-11-22T00:00:00Z'),
  })
  return { projectId, channelId, ticket }
}

describe('core commands', () => {
  it('approves a plan and queues the next turn', async () => {
    const { projectId, channelId, ticket } = await seed('plan_review')
    const result = await handleCoreCommand({
      db: handle.db,
      projectId,
      channelId,
      threadKey: 'thread-cmd',
      role: 'maintainer',
      command: { name: 'approve', arg: '', raw: '/approve' },
      at: new Date('2026-11-22T00:01:00Z'),
    })
    expect(result.action).toBe('command')
    const [stored] = await handle.db.select().from(tickets).where(eq(tickets.id, ticket.id))
    expect(stored?.stage).toBe('queued')
    const inputs = await handle.db.select().from(ticketInputs).where(eq(ticketInputs.ticketId, ticket.id))
    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.kind).toBe('approval')
    const turns = await handle.db.select().from(sessionTurns).where(eq(sessionTurns.ticketId, ticket.id))
    expect(turns).toHaveLength(1)
    expect(turns[0]?.status).toBe('queued')
    expect(await handle.db.select().from(outboxEvents).where(eq(outboxEvents.projectId, projectId))).toHaveLength(1)
  })

  it('reports status and cancels a ticket', async () => {
    const { projectId, channelId, ticket } = await seed('failed')
    const status = await handleCoreCommand({
      db: handle.db,
      projectId,
      channelId,
      threadKey: 'thread-cmd',
      role: 'viewer',
      command: { name: 'status', arg: '', raw: '/status' },
      at: new Date('2026-11-22T00:02:00Z'),
    })
    expect(status.action).toBe('command')
    expect(status.reply).toContain('failed')

    const cancelled = await handleCoreCommand({
      db: handle.db,
      projectId,
      channelId,
      threadKey: 'thread-cmd',
      role: 'maintainer',
      command: { name: 'cancel', arg: '', raw: '/cancel' },
      at: new Date('2026-11-22T00:03:00Z'),
    })
    expect(cancelled.action).toBe('command')
    const [stored] = await handle.db.select().from(tickets).where(eq(tickets.id, ticket.id))
    expect(stored?.stage).toBe('cancelled')
  })

  it('refuses maintainer commands from viewers', async () => {
    const { projectId, channelId } = await seed('plan_review')
    const result = await handleCoreCommand({
      db: handle.db,
      projectId,
      channelId,
      threadKey: 'thread-cmd',
      role: 'viewer',
      command: { name: 'approve', arg: '', raw: '/approve' },
      at: new Date('2026-11-22T00:04:00Z'),
    })
    expect(result.action).toBe('ignored')
    expect(result.reason).toBe('insufficient_role')
  })
})
