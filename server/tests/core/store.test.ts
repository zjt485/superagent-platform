import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTestDatabase } from '../helpers/db.js'
import type { DatabaseHandle } from '../../src/db/client.js'
import {
  agentSessions,
  channels,
  evaluations,
  projects,
  users,
} from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY } from '../../src/domain/policy.js'
import { listPendingTriggers, listRecentTriggers, insertTrigger, setTriggerDisposition } from '../../src/core/store/triggers.js'
import { claimPendingThread, getThread, markThreadPending, releaseThread, touchThread } from '../../src/core/store/threads.js'
import { getTicket, insertTicket, setTicketStage, setTicketWorktree } from '../../src/core/store/tickets.js'
import { finishTurn, getTurn, insertTurn, nextTurnSeq } from '../../src/core/store/turns.js'
import { insertDecisions, listDecisionsByRun } from '../../src/core/store/decisions.js'

let handle: DatabaseHandle

beforeAll(async () => {
  handle = await openTestDatabase()
})

afterAll(async () => {
  await handle.close()
})

async function seedProject(): Promise<{ userId: string; projectId: string; channelId: string }> {
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

describe('core store', () => {
  it('inserts triggers idempotently and lists pending rows', async () => {
    const { projectId, channelId } = await seedProject()
    const trigger = {
      id: newId(),
      projectId,
      channelId,
      provider: 'feishu',
      externalId: `msg-${newId()}`,
      threadKey: 'thread-1',
      actorExternalId: 'ou_1',
      actorName: 'Alice',
      text: 'fix the login page',
      address: 'mention' as const,
      createdAt: new Date('2026-11-22T00:00:00Z'),
    }
    expect(await insertTrigger(handle.db, trigger)).toBe(true)
    expect(await insertTrigger(handle.db, { ...trigger, id: newId() })).toBe(false)

    const pending = await listPendingTriggers(handle.db, { projectId, channelId, threadKey: 'thread-1' }, 10)
    expect(pending.map((row) => row.id)).toEqual([trigger.id])

    await setTriggerDisposition(handle.db, trigger.id, 'ignored')
    expect(await listPendingTriggers(handle.db, { projectId, channelId, threadKey: 'thread-1' }, 10)).toEqual([])
    const recent = await listRecentTriggers(handle.db, { projectId, channelId, threadKey: 'thread-1' }, 10)
    expect(recent).toHaveLength(1)
    expect(recent[0]?.disposition).toBe('ignored')
  })

  it('claims a pending thread once and releases it with a summary', async () => {
    const { projectId, channelId } = await seedProject()
    const scope = { projectId, channelId, threadKey: 'thread-2' }
    await touchThread(handle.db, { ...scope, at: new Date('2026-11-22T00:00:00Z') })
    await markThreadPending(handle.db, scope, new Date('2026-11-22T00:00:01Z'))

    const now = new Date('2026-11-22T00:00:02Z')
    const claimed = await claimPendingThread(handle.db, now, 60_000)
    expect(claimed?.threadKey).toBe('thread-2')
    expect(await claimPendingThread(handle.db, now, 60_000)).toBeUndefined()

    await releaseThread(handle.db, claimed?.id ?? '', 'summary text')
    const thread = await getThread(handle.db, scope)
    expect(thread?.routerPending).toBe(false)
    expect(thread?.summary).toBe('summary text')
  })

  it('inserts tickets and projects stages onto legacy statuses', async () => {
    const { projectId, channelId, userId } = await seedProject()
    const ticket = await insertTicket(handle.db, {
      id: newId(),
      projectId,
      channelId,
      threadKey: 'thread-3',
      requesterId: userId,
      title: 'Fix login',
      body: 'details',
      shortName: 't-abc123',
      stage: 'queued',
      at: new Date('2026-11-22T00:00:00Z'),
    })
    expect(ticket.status).toBe('triaged')
    expect(ticket.stage).toBe('queued')

    const working = await setTicketStage(handle.db, ticket.id, 'working', new Date('2026-11-22T00:01:00Z'))
    expect(working?.status).toBe('running')
    const done = await setTicketStage(handle.db, ticket.id, 'done', new Date('2026-11-22T00:02:00Z'))
    expect(done?.status).toBe('done')
    expect(done?.endedAt).toBeInstanceOf(Date)

    await setTicketWorktree(handle.db, ticket.id, {
      branch: 'agent/t-abc123',
      worktreePath: '/tmp/wt',
      baseRef: 'main',
      at: new Date('2026-11-22T00:03:00Z'),
    })
    expect((await getTicket(handle.db, ticket.id))?.worktreePath).toBe('/tmp/wt')
  })

  it('allocates turn sequence numbers and finishes a turn', async () => {
    const { projectId, channelId } = await seedProject()
    const ticket = await insertTicket(handle.db, {
      id: newId(),
      projectId,
      channelId,
      threadKey: 'thread-4',
      title: 'Fix login',
      body: 'details',
      shortName: 't-def456',
      stage: 'queued',
      at: new Date('2026-11-22T00:00:00Z'),
    })
    const sessionId = newId()
    await handle.db.insert(agentSessions).values({
      id: sessionId,
      projectId,
      role: 'executor',
      ticketId: ticket.id,
      status: 'idle',
    })

    expect(await nextTurnSeq(handle.db, ticket.id)).toBe(1)
    const turn = await insertTurn(handle.db, {
      id: newId(),
      projectId,
      sessionId,
      ticketId: ticket.id,
      seq: 1,
      inputIds: ['input-1'],
      at: new Date('2026-11-22T00:00:00Z'),
    })
    expect(await nextTurnSeq(handle.db, ticket.id)).toBe(2)

    await finishTurn(handle.db, turn.id, {
      status: 'succeeded',
      result: { status: 'ready', summary: 'done' },
      tokens: 42,
      at: new Date('2026-11-22T00:01:00Z'),
    })
    const finished = await getTurn(handle.db, turn.id)
    expect(finished?.status).toBe('succeeded')
    expect(finished?.tokens).toBe(42)
    expect(finished?.result).toEqual({ status: 'ready', summary: 'done' })
  })

  it('stores one decision per trigger per router run', async () => {
    const { projectId, channelId } = await seedProject()
    const triggerId = newId()
    await insertTrigger(handle.db, {
      id: triggerId,
      projectId,
      channelId,
      provider: 'feishu',
      externalId: `msg-${triggerId.slice(0, 8)}`,
      threadKey: 'thread-5',
      text: 'fix the login page',
      address: 'mention',
      createdAt: new Date('2026-11-22T00:00:00Z'),
    })
    await handle.db.insert(evaluations).values({
      id: newId(),
      projectId,
      channelId,
      threadKey: 'thread-5',
      policyVersion: 'v1',
      status: 'running',
      triggerIds: [triggerId],
      createdAt: new Date('2026-11-22T00:00:00Z'),
    })
    const [run] = await handle.db.select().from(evaluations)
    if (run === undefined) throw new Error('missing run')

    const row = {
      id: newId(),
      projectId,
      runId: run.id,
      triggerId,
      threadKey: 'thread-5',
      action: 'new' as const,
      title: 'Fix login',
      reason: 'explicit request',
      decidedAt: new Date('2026-11-22T00:00:01Z'),
    }
    expect(await insertDecisions(handle.db, [row])).toBe(1)
    expect(await insertDecisions(handle.db, [{ ...row, id: newId() }])).toBe(0)
    const list = await listDecisionsByRun(handle.db, run.id)
    expect(list).toHaveLength(1)
    expect(list[0]?.action).toBe('new')
  })
})
