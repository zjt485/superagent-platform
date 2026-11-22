import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTestDatabase } from '../helpers/db.js'
import type { DatabaseHandle } from '../../src/db/client.js'
import { channels, projects, triggers, users } from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY } from '../../src/domain/policy.js'
import { receiveCoreTrigger } from '../../src/core/intake.js'
import { getThread } from '../../src/core/store/threads.js'

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

function inbound(projectId: string, channelId: string, overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    channelId,
    provider: 'feishu',
    externalId: `msg-${newId()}`,
    threadKey: 'thread-intake',
    actorExternalId: 'ou_alice',
    actorName: 'Alice',
    text: '修复登录页',
    address: 'mention' as const,
    at: new Date('2026-11-22T00:00:00Z'),
    ...overrides,
  }
}

describe('core intake', () => {
  it('stores a normal message, touches the thread and marks it pending', async () => {
    const { projectId, channelId } = await seed()
    const result = await receiveCoreTrigger(handle.db, inbound(projectId, channelId))
    expect(result.action).toBe('queued')
    const thread = await getThread(handle.db, { projectId, channelId, threadKey: 'thread-intake' })
    expect(thread?.routerPending).toBe(true)
    const rows = await handle.db.select().from(triggers)
    expect(rows.some((row) => row.id === result.triggerId && row.disposition === 'pending')).toBe(true)
  })

  it('deduplicates by provider and external id', async () => {
    const { projectId, channelId } = await seed()
    const input = inbound(projectId, channelId)
    expect((await receiveCoreTrigger(handle.db, input)).action).toBe('queued')
    expect((await receiveCoreTrigger(handle.db, input)).action).toBe('duplicate')
  })

  it('records commands without making the thread pending', async () => {
    const { projectId, channelId } = await seed()
    const result = await receiveCoreTrigger(handle.db, inbound(projectId, channelId, { text: '/status' }))
    expect(result.action).toBe('command')
    const thread = await getThread(handle.db, { projectId, channelId, threadKey: 'thread-intake' })
    expect(thread?.routerPending).toBe(false)
    const rows = await handle.db.select().from(triggers)
    expect(rows.find((row) => row.id === result.triggerId)?.disposition).toBe('command')
  })

  it('ignores bots, unauthorized senders and empty text', async () => {
    const { projectId, channelId } = await seed()
    expect((await receiveCoreTrigger(handle.db, inbound(projectId, channelId, { isBot: true }))).action).toBe('ignored')
    expect((await receiveCoreTrigger(handle.db, inbound(projectId, channelId, { authorized: false }))).action).toBe('ignored')
    expect((await receiveCoreTrigger(handle.db, inbound(projectId, channelId, { text: '   ' }))).action).toBe('ignored')
  })
})
