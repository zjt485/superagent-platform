import { describe, expect, it } from 'vitest'

import {
  InvalidStageTransition,
  isTerminalStage,
  nextStage,
  statusOfStage,
} from '../../src/core/domain/stage.js'
import type { StageEvent, TicketStage } from '../../src/core/domain/types.js'

const stages: TicketStage[] = [
  'queued',
  'working',
  'plan_review',
  'idle',
  'review',
  'answer',
  'blocked',
  'failed',
  'done',
  'cancelled',
]

const events: StageEvent[] = [
  { type: 'dispatch' },
  { type: 'progress' },
  { type: 'waiting', plan: true },
  { type: 'waiting', plan: false },
  { type: 'ready', codeChanged: true },
  { type: 'ready', codeChanged: false },
  { type: 'blocked' },
  { type: 'failed' },
  { type: 'approve' },
  { type: 'reject' },
  { type: 'input' },
  { type: 'retry' },
  { type: 'stop' },
  { type: 'merge' },
  { type: 'close' },
]

function eventKey(event: StageEvent): string {
  if (event.type === 'waiting') return `waiting:${event.plan}`
  if (event.type === 'ready') return `ready:${event.codeChanged}`
  return event.type
}

const allowed: Array<[TicketStage, StageEvent, TicketStage]> = [
  ['queued', { type: 'dispatch' }, 'working'],
  ['queued', { type: 'input' }, 'queued'],
  ['queued', { type: 'stop' }, 'cancelled'],
  ['working', { type: 'progress' }, 'working'],
  ['working', { type: 'waiting', plan: true }, 'plan_review'],
  ['working', { type: 'waiting', plan: false }, 'idle'],
  ['working', { type: 'ready', codeChanged: true }, 'review'],
  ['working', { type: 'ready', codeChanged: false }, 'answer'],
  ['working', { type: 'blocked' }, 'blocked'],
  ['working', { type: 'failed' }, 'failed'],
  ['working', { type: 'input' }, 'working'],
  ['working', { type: 'stop' }, 'cancelled'],
  ['plan_review', { type: 'approve' }, 'queued'],
  ['plan_review', { type: 'reject' }, 'cancelled'],
  ['plan_review', { type: 'stop' }, 'cancelled'],
  ['idle', { type: 'input' }, 'queued'],
  ['idle', { type: 'dispatch' }, 'working'],
  ['idle', { type: 'stop' }, 'cancelled'],
  ['review', { type: 'input' }, 'queued'],
  ['review', { type: 'merge' }, 'done'],
  ['review', { type: 'close' }, 'cancelled'],
  ['review', { type: 'stop' }, 'cancelled'],
  ['answer', { type: 'input' }, 'queued'],
  ['answer', { type: 'close' }, 'done'],
  ['answer', { type: 'stop' }, 'cancelled'],
  ['blocked', { type: 'input' }, 'queued'],
  ['blocked', { type: 'retry' }, 'queued'],
  ['blocked', { type: 'stop' }, 'cancelled'],
  ['failed', { type: 'input' }, 'queued'],
  ['failed', { type: 'retry' }, 'queued'],
  ['failed', { type: 'stop' }, 'cancelled'],
  ['done', { type: 'input' }, 'queued'],
]

describe('ticket stage machine', () => {
  it('allows every transition in the table', () => {
    for (const [from, event, to] of allowed) {
      expect(nextStage(from, event), `${from} + ${eventKey(event)}`).toBe(to)
    }
  })

  it('rejects every transition not in the table', () => {
    for (const stage of stages) {
      for (const event of events) {
        const key = `${stage}:${eventKey(event)}`
        const known = allowed.some(([from, candidate]) => from === stage && eventKey(candidate) === eventKey(event))
        if (known) continue
        expect(() => nextStage(stage, event), key).toThrow(InvalidStageTransition)
      }
    }
  })

  it('treats cancelled as the only terminal stage', () => {
    for (const stage of stages) {
      expect(isTerminalStage(stage), stage).toBe(stage === 'cancelled')
    }
  })

  it('projects every stage to a legacy ticket status', () => {
    const expected: Record<TicketStage, string> = {
      queued: 'triaged',
      working: 'running',
      plan_review: 'planned',
      idle: 'waiting_review',
      review: 'waiting_review',
      answer: 'waiting_review',
      blocked: 'waiting_review',
      failed: 'failed',
      done: 'done',
      cancelled: 'cancelled',
    }
    for (const stage of stages) {
      expect(statusOfStage(stage), stage).toBe(expected[stage])
    }
  })

  it('reports the rejected transition in the error message', () => {
    expect(() => nextStage('cancelled', { type: 'input' })).toThrow(
      'cancelled + input',
    )
  })
})
