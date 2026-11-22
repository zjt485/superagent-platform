import { describe, expect, it } from 'vitest'

import { RuleBasedRouterModel } from '../../src/core/router/model.js'
import type { RouterDecisionContext } from '../../src/core/router/model.js'

const context: RouterDecisionContext = {
  board: 'board text',
  project: { id: 'p1', name: 'Demo', planApproval: 'auto', allowThreadReplies: true },
  tickets: [{ shortName: 't-abc123', title: 'Fix login', stage: 'working' }],
  batch: [
    { id: 'trigger-1', senderName: 'Alice', text: '请把登录接口超时改成 30 秒', at: '2026-11-22T00:00:00Z', address: 'mention' },
    { id: 'trigger-2', senderName: 'Bob', text: '哈哈哈', at: '2026-11-22T00:00:01Z', address: 'mention' },
    { id: 'trigger-3', senderName: 'Alice', text: '/status', at: '2026-11-22T00:00:02Z', address: 'mention' },
  ],
}

describe('rule based router model', () => {
  it('classifies a task as new, chat as ignore and a command as command', async () => {
    const model = new RuleBasedRouterModel()
    const output = await model.decide(context)
    expect(output.items).toHaveLength(3)
    expect(output.items.find((item) => item.triggerId === 'trigger-1')?.action).toBe('new')
    expect(output.items.find((item) => item.triggerId === 'trigger-2')?.action).toBe('ignore')
    expect(output.items.find((item) => item.triggerId === 'trigger-3')?.action).toBe('command')
  })

  it('creates a title from the task text', async () => {
    const model = new RuleBasedRouterModel()
    const output = await model.decide({ ...context, batch: [context.batch[0]!] })
    const item = output.items[0]
    expect(item?.title).toContain('登录接口超时')
    expect(item?.reason).toContain('rule')
  })

  it('attaches when the text names an open ticket short name', async () => {
    const model = new RuleBasedRouterModel()
    const output = await model.decide({
      ...context,
      batch: [{ ...context.batch[0]!, text: 't-abc123 这个再改一下' }],
    })
    expect(output.items[0]?.action).toBe('attach')
    expect(output.items[0]?.ticketId).toBe('t-abc123')
  })
})
