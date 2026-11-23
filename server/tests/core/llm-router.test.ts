import { describe, expect, it } from 'vitest'

import { LlmRouterModel } from '../../src/core/router/llm-model.js'
import type { RouterDecisionContext } from '../../src/core/router/model.js'

const context: RouterDecisionContext = {
  board: '## This batch\n- id=trigger-1: fix login',
  project: { id: 'p1', name: 'Demo', planApproval: 'auto', allowThreadReplies: true },
  tickets: [],
  batch: [{ id: 'trigger-1', senderName: 'Alice', text: 'fix login', at: '2026-11-22T00:00:00Z', address: 'mention' }],
}

function response(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('llm router model', () => {
  it('parses a JSON decision and sends the board to the model', async () => {
    const calls: Array<{ url: string; body: any }> = []
    const model = new LlmRouterModel({
      baseUrl: 'https://llm.test/v1',
      apiKey: 'secret',
      model: 'test-model',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) })
        return response({ summary: 'one task', items: [{ triggerId: 'trigger-1', action: 'new', title: 'Fix login', reason: 'task' }] })
      }) as typeof fetch,
    })
    const output = await model.decide(context)
    expect(output.items[0]?.action).toBe('new')
    expect(calls[0]?.url).toBe('https://llm.test/v1/chat/completions')
    expect(calls[0]?.body.model).toBe('test-model')
    expect(calls[0]?.body.messages[1].content).toContain('trigger-1')
  })

  it('retries once after invalid JSON', async () => {
    let calls = 0
    const model = new LlmRouterModel({
      baseUrl: 'https://llm.test/v1',
      apiKey: '',
      model: 'test-model',
      fetchImpl: (async () => {
        calls += 1
        return calls === 1 ? response('not json') : response({ summary: 'ok', items: [] })
      }) as typeof fetch,
    })
    const output = await model.decide(context)
    expect(output.summary).toBe('ok')
    expect(calls).toBe(2)
  })

  it('throws after repeated HTTP failures', async () => {
    const model = new LlmRouterModel({
      baseUrl: 'https://llm.test/v1',
      apiKey: '',
      model: 'test-model',
      fetchImpl: (async () => response({}, 500)) as typeof fetch,
    })
    await expect(model.decide(context)).rejects.toThrow('HTTP 500')
  })

  it('strips a fenced JSON code block', async () => {
    const model = new LlmRouterModel({
      baseUrl: 'https://llm.test/v1',
      apiKey: '',
      model: 'test-model',
      fetchImpl: (async () =>
        response('```json\n{"summary":"ok","items":[]}\n```')) as typeof fetch,
    })
    const output = await model.decide(context)
    expect(output.summary).toBe('ok')
  })
})
