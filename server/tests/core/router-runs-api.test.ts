import { describe, expect, it } from 'vitest'

import { api, cookieOf, createHarness } from '../helpers/app.js'
import { decisions, evaluations, triggers } from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'

describe('router runs api', () => {
  it('lists router runs and their decisions for a project member', async () => {
    const harness = await createHarness()
    const login = await api(harness, 'POST', '/v1/auth/dev-login', { body: { name: 'Alice' } })
    const cookie = cookieOf(login)
    const created = await api(harness, 'POST', '/v1/projects', { cookie, body: { name: 'Demo' } })
    const projectId = created.json.project.id as string

    const triggerId = newId()
    await harness.ctx.db.insert(triggers).values({
      id: triggerId,
      projectId,
      provider: 'feishu',
      externalId: `msg-${triggerId.slice(0, 8)}`,
      text: '修复登录页',
      createdAt: new Date('2026-11-22T00:00:00Z'),
    })
    const runId = newId()
    await harness.ctx.db.insert(evaluations).values({
      id: runId,
      projectId,
      threadKey: 'thread-1',
      policyVersion: 'v1',
      status: 'decided',
      triggerIds: [triggerId],
      model: 'rule-based',
      summary: 'one new ticket',
      createdAt: new Date('2026-11-22T00:00:01Z'),
    })
    await harness.ctx.db.insert(decisions).values({
      id: newId(),
      projectId,
      runId,
      triggerId,
      threadKey: 'thread-1',
      action: 'new',
      title: '修复登录页',
      reason: 'task',
      decidedAt: new Date('2026-11-22T00:00:01Z'),
    })

    const response = await api(harness, 'GET', `/v1/projects/${projectId}/router-runs`, { cookie })
    expect(response.status).toBe(200)
    expect(response.json.items).toHaveLength(1)
    expect(response.json.items[0].id).toBe(runId)
    expect(response.json.items[0].decisions).toHaveLength(1)
    expect(response.json.items[0].decisions[0].action).toBe('new')

    expect((await api(harness, 'GET', `/v1/projects/${projectId}/router-runs`)).status).toBe(401)
    await harness.close()
  })
})
