import { describe, expect, it } from 'vitest'

import { renderBoard } from '../../src/core/router/board.js'

const base = {
  project: { id: 'p1', name: 'Demo', planApproval: 'required' as const, allowThreadReplies: true },
  thread: { key: 'feishu:chat-1:thread-1', summary: 'Earlier the team discussed the login page.' },
  tickets: [
    { shortName: 't-abc123', title: 'Fix login', stage: 'working' as const, lastReport: 'waiting for tests' },
  ],
  recent: [
    { id: 'm1', senderName: 'Alice', text: 'the login page is slow', at: '2026-11-22T00:00:00Z', address: 'mention' as const },
  ],
  batch: [
    { id: 'trigger-1', senderName: 'Bob', text: 'make it 30 seconds', at: '2026-11-22T00:01:00Z', address: 'mention' as const },
  ],
}

describe('router board', () => {
  it('renders project, thread, tickets, recent and batch sections', () => {
    const board = renderBoard(base)
    expect(board).toContain('## Project')
    expect(board).toContain('Demo')
    expect(board).toContain('plan approval: required')
    expect(board).toContain('Earlier the team discussed the login page.')
    expect(board).toContain('t-abc123')
    expect(board).toContain('[working]')
    expect(board).toContain('waiting for tests')
    expect(board).toContain('## Recent messages')
    expect(board).toContain('the login page is slow')
    expect(board).toContain('## This batch')
    expect(board).toContain('id=trigger-1')
    expect(board).toContain('make it 30 seconds')
  })

  it('handles an empty summary, no tickets and no recent messages', () => {
    const board = renderBoard({
      ...base,
      thread: { key: 'feishu:chat-1:thread-2', summary: null },
      tickets: [],
      recent: [],
    })
    expect(board).toContain('(no summary)')
    expect(board).toContain('(no open tickets)')
    expect(board).toContain('(no recent messages)')
  })

  it('truncates long text and preserves the trigger id', () => {
    const long = 'x'.repeat(200)
    const board = renderBoard({ ...base, batch: [{ ...base.batch[0]!, text: long }] }, { maxTextChars: 20 })
    expect(board).toContain('id=trigger-1')
    expect(board).toContain('x'.repeat(20))
    expect(board).not.toContain('x'.repeat(21))
  })
})
