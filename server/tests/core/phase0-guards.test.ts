import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { openTestDatabase } from '../helpers/db.js'
import type { DatabaseHandle } from '../../src/db/client.js'
import {
  agentSessions,
  channels,
  decisions,
  evaluations,
  outboxEvents,
  projects,
  sessionTurns,
  ticketInputs,
  tickets,
  usage,
  users,
} from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY } from '../../src/domain/policy.js'
import { renderBoard } from '../../src/core/router/board.js'
import { flushThread } from '../../src/core/router/flush.js'
import { LlmRouterModel } from '../../src/core/router/llm-model.js'
import { insertTrigger } from '../../src/core/store/triggers.js'
import { getThread, markThreadPending, touchThread } from '../../src/core/store/threads.js'
import { insertTicket } from '../../src/core/store/tickets.js'
import { insertTurn } from '../../src/core/store/turns.js'
import { dispatchOnce } from '../../src/core/worker/dispatcher.js'
import { FakeExecutor } from '../../src/core/worker/fake-executor.js'
import { reapStaleCoreTurns } from '../../src/core/worker/reaper.js'

const handles: DatabaseHandle[] = []

afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.close()
})

async function openFreshDb(): Promise<DatabaseHandle> {
  const h = await openTestDatabase()
  handles.push(h)
  return h
}

async function seedProject(handle: DatabaseHandle, policyOverrides: Partial<typeof DEFAULT_POLICY> = {}) {
  const userId = newId()
  const projectId = newId()
  const channelId = newId()
  await handle.db.insert(users).values({ id: userId, name: 'Alice' })
  const [project] = await handle.db
    .insert(projects)
    .values({
      id: projectId,
      name: 'Phase0 Project',
      slug: `phase0-${projectId.slice(0, 8)}`,
      ownerId: userId,
      status: 'active',
      policyJson: { ...DEFAULT_POLICY, ...policyOverrides },
      modelConfig: DEFAULT_MODEL_CONFIG,
    })
    .returning()
  await handle.db.insert(channels).values({
    id: channelId,
    projectId,
    provider: 'feishu',
    externalChatId: `chat-${channelId.slice(0, 8)}`,
    status: 'active',
    config: {},
  })
  return { userId, projectId, channelId, project: project! }
}

describe('Phase 0 core guards and fixes', () => {
  it('renders ticket UUID on the board and resolves attach/stop by shortName with UUID in decisions', async () => {
    const handle = await openFreshDb()
    const { projectId, channelId, project } = await seedProject(handle)
    const at = new Date('2026-11-26T00:00:00Z')
    const ticket = await insertTicket(handle.db, {
      id: newId(),
      projectId,
      channelId,
      threadKey: 'thread-short',
      title: 'Fix auth timeout',
      body: 'increase timeout',
      shortName: 't-fix001',
      stage: 'idle',
      at,
    })

    const rendered = renderBoard({
      project: { id: projectId, name: project.name, planApproval: 'auto', allowThreadReplies: true },
      thread: { key: 'thread-short', summary: null },
      tickets: [{ id: ticket.id, shortName: 't-fix001', title: ticket.title, stage: 'idle' }],
      recent: [],
      batch: [],
    })
    expect(rendered).toContain(`t-fix001 (id=${ticket.id})`)

    const triggerId = newId()
    await insertTrigger(handle.db, {
      id: triggerId,
      projectId,
      channelId,
      provider: 'feishu',
      externalId: `msg-${triggerId.slice(0, 8)}`,
      threadKey: 'thread-short',
      actorName: 'Alice',
      text: 'also handle refresh token',
      address: 'mention',
      createdAt: at,
    })
    await touchThread(handle.db, { projectId, channelId, threadKey: 'thread-short', at })
    await markThreadPending(handle.db, { projectId, channelId, threadKey: 'thread-short' }, at)
    const thread = (await getThread(handle.db, { projectId, channelId, threadKey: 'thread-short' }))!

    const llm = new LlmRouterModel({
      baseUrl: 'https://llm.test/v1',
      apiKey: 'key',
      model: 'deepseek-chat',
      inputCostPer1M: 1,
      outputCostPer1M: 2,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'attach by shortName',
                    items: [{ triggerId, action: 'attach', ticketId: 't-fix001', reason: 'follow-up' }],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 400, completion_tokens: 100, total_tokens: 500 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    })

    const flushed = await flushThread({
      db: handle.db,
      project,
      thread,
      model: llm,
      policyVersion: 'v1',
      at,
    })

    expect(flushed.turnIds).toHaveLength(1)
    const [decision] = await handle.db.select().from(decisions).where(eq(decisions.triggerId, triggerId))
    expect(decision?.ticketId).toBe(ticket.id)
    const [evalRow] = await handle.db.select().from(evaluations).where(eq(evaluations.id, flushed.runId!))
    expect(evalRow?.promptTokens).toBe(400)
    expect(evalRow?.outputTokens).toBe(100)
    const [usageRow] = await handle.db.select().from(usage).where(eq(usage.projectId, projectId))
    expect(usageRow?.tokens).toBe(500)
    const inputs = await handle.db.select().from(ticketInputs).where(eq(ticketInputs.ticketId, ticket.id))
    expect(inputs).toHaveLength(1)
  })

  it('enforces project maxConcurrentRuns and dailyTokenBudget in dispatcher', async () => {
    const handle = await openFreshDb()
    const { projectId, channelId } = await seedProject(handle, { maxConcurrentRuns: 1, dailyTokenBudget: 1000 })
    const at = new Date('2026-11-26T01:00:00Z')

    const makeTicketTurn = async (shortName: string, running = false) => {
      const ticket = await insertTicket(handle.db, {
        id: newId(),
        projectId,
        channelId,
        threadKey: `th-${shortName}`,
        title: `Task ${shortName}`,
        body: 'body',
        shortName,
        stage: running ? 'working' : 'queued',
        at,
      })
      const sessionId = newId()
      await handle.db.insert(agentSessions).values({ id: sessionId, projectId, role: 'executor', ticketId: ticket.id, status: running ? 'running' : 'idle' })
      const turn = await insertTurn(handle.db, { id: newId(), projectId, sessionId, ticketId: ticket.id, seq: 1, inputIds: [], at })
      if (running) {
        await handle.db.update(sessionTurns).set({ status: 'running', startedAt: at, heartbeatAt: at }).where(eq(sessionTurns.id, turn.id))
      }
      return { ticket, turn }
    }

    const first = await makeTicketTurn('t-conc01', true)
    const second = await makeTicketTurn('t-conc02', false)

    // Concurrency limit = 1, so second turn cannot be claimed while first is running.
    const ranWhileFull = await dispatchOnce({
      db: handle.db,
      executor: new FakeExecutor(() => ({ status: 'ready', summary: 'ok' })),
      now: () => at,
    })
    expect(ranWhileFull).toBe(false)

    // Free slot, then exhaust daily budget and verify dispatcher fails turn cleanly.
    await handle.db.update(sessionTurns).set({ status: 'succeeded', endedAt: at }).where(eq(sessionTurns.id, first.turn.id))
    await handle.db.insert(usage).values({ id: newId(), projectId, day: '2026-11-26', runs: 1, tokens: 1200, cost: 0 })

    const ranOverBudget = await dispatchOnce({
      db: handle.db,
      executor: new FakeExecutor(() => ({ status: 'ready', summary: 'should not run' })),
      now: () => at,
    })
    expect(ranOverBudget).toBe(true)
    const [secondTurn] = await handle.db.select().from(sessionTurns).where(eq(sessionTurns.id, second.turn.id))
    expect(secondTurn?.status).toBe('failed')
    expect(secondTurn?.error).toContain('Token 预算')
    const [secondTicket] = await handle.db.select().from(tickets).where(eq(tickets.id, second.ticket.id))
    expect(secondTicket?.stage).toBe('failed')
  })

  it('reaps stale running turns and marks their tickets failed with an outbox notification', async () => {
    const handle = await openFreshDb()
    const { projectId, channelId } = await seedProject(handle)
    const startedAt = new Date('2026-11-26T02:00:00Z')
    const now = new Date('2026-11-26T02:05:00Z')
    const ticket = await insertTicket(handle.db, {
      id: newId(),
      projectId,
      channelId,
      threadKey: 'thread-stale',
      title: 'Stuck job',
      body: 'body',
      shortName: 't-stale1',
      stage: 'working',
      at: startedAt,
    })
    const sessionId = newId()
    await handle.db.insert(agentSessions).values({ id: sessionId, projectId, role: 'executor', ticketId: ticket.id, status: 'running' })
    const turn = await insertTurn(handle.db, { id: newId(), projectId, sessionId, ticketId: ticket.id, seq: 1, inputIds: [], at: startedAt })
    await handle.db
      .update(sessionTurns)
      .set({ status: 'running', startedAt, heartbeatAt: startedAt })
      .where(eq(sessionTurns.id, turn.id))

    const reaped = await reapStaleCoreTurns({ db: handle.db, now: () => now, leaseSeconds: 120 })
    expect(reaped).toBe(1)

    const [updatedTurn] = await handle.db.select().from(sessionTurns).where(eq(sessionTurns.id, turn.id))
    expect(updatedTurn?.status).toBe('timeout')
    const [updatedTicket] = await handle.db.select().from(tickets).where(eq(tickets.id, ticket.id))
    expect(updatedTicket?.stage).toBe('failed')
    const [session] = await handle.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId))
    expect(session?.status).toBe('idle')
    const outbox = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.dedupeKey, `timeout:${turn.id}`))
    expect(outbox).toHaveLength(1)
  })
})
