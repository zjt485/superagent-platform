import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { openTestDatabase } from '../helpers/db.js'
import type { DatabaseHandle } from '../../src/db/client.js'
import {
  agentSessions,
  channels,
  outboxEvents,
  projects,
  reports,
  sessionTurns,
  ticketInputs,
  tickets,
  users,
} from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY } from '../../src/domain/policy.js'
import { insertTicket } from '../../src/core/store/tickets.js'
import { insertTurn } from '../../src/core/store/turns.js'
import { insertTicketInput } from '../../src/core/store/inputs.js'
import { dispatchOnce } from '../../src/core/worker/dispatcher.js'
import { FakeExecutor } from '../../src/core/worker/fake-executor.js'

let handle: DatabaseHandle

beforeAll(async () => {
  handle = await openTestDatabase()
})

afterAll(async () => {
  await handle.close()
})

async function seedTurn() {
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
  const ticket = await insertTicket(handle.db, {
    id: newId(),
    projectId,
    channelId,
    threadKey: `thread-${projectId.slice(0, 6)}`,
    title: 'Fix login',
    body: 'details',
    shortName: `t-${projectId.slice(0, 6)}`,
    stage: 'queued',
    at,
  })
  const sessionId = newId()
  await handle.db.insert(agentSessions).values({
    id: sessionId,
    projectId,
    role: 'executor',
    ticketId: ticket.id,
    status: 'idle',
  })
  const input = await insertTicketInput(handle.db, {
    id: newId(),
    projectId,
    ticketId: ticket.id,
    source: 'trigger',
    kind: 'message',
    text: '修复登录页',
    isPerson: true,
    at,
  })
  const turn = await insertTurn(handle.db, {
    id: newId(),
    projectId,
    sessionId,
    ticketId: ticket.id,
    seq: 1,
    inputIds: [input.id],
    at,
  })
  return { projectId, channelId, ticket, sessionId, turn, input }
}

describe('core dispatcher', () => {
  it('runs a ready turn, records a report and opens the review stage', async () => {
    const { projectId, ticket, turn, input } = await seedTurn()
    const executor = new FakeExecutor(() => ({
      status: 'ready',
      summary: 'opened a PR',
      changedFiles: ['src/login.ts'],
      tokens: 12,
    }))

    expect(await dispatchOnce({ db: handle.db, executor, now: () => new Date('2026-11-22T00:01:00Z') })).toBe(true)

    const [finished] = await handle.db.select().from(sessionTurns).where(eq(sessionTurns.id, turn.id))
    expect(finished?.status).toBe('succeeded')
    const [stored] = await handle.db.select().from(tickets).where(eq(tickets.id, ticket.id))
    expect(stored?.stage).toBe('review')
    expect(await handle.db.select().from(reports).where(eq(reports.ticketId, ticket.id))).toHaveLength(1)
    expect(await handle.db.select().from(outboxEvents).where(eq(outboxEvents.projectId, projectId))).toHaveLength(1)
    const [delivered] = await handle.db.select().from(ticketInputs).where(eq(ticketInputs.id, input.id))
    expect(delivered?.deliveredTurnId).toBe(turn.id)
  })

  it('moves a waiting plan to plan_review and a thrown executor to failed', async () => {
    const planned = await seedTurn()
    const planExecutor = new FakeExecutor(() => ({
      status: 'waiting',
      summary: 'plan ready',
      plan: '1. change timeout',
    }))
    await dispatchOnce({ db: handle.db, executor: planExecutor, now: () => new Date('2026-11-22T00:02:00Z') })
    const [plannedTicket] = await handle.db.select().from(tickets).where(eq(tickets.id, planned.ticket.id))
    expect(plannedTicket?.stage).toBe('plan_review')

    const failed = await seedTurn()
    const badExecutor = new FakeExecutor(() => {
      throw new Error('model exploded')
    })
    await dispatchOnce({ db: handle.db, executor: badExecutor, now: () => new Date('2026-11-22T00:03:00Z') })
    const [failedTicket] = await handle.db.select().from(tickets).where(eq(tickets.id, failed.ticket.id))
    expect(failedTicket?.stage).toBe('failed')
    const [failedTurn] = await handle.db.select().from(sessionTurns).where(eq(sessionTurns.id, failed.turn.id))
    expect(failedTurn?.status).toBe('failed')
  })
})
