import { describe, expect, it } from 'vitest'

import {
  RouterOutputError,
  parseRouterOutput,
  validateRouterOutput,
} from '../../src/core/router/output.js'

const batch = ['trigger-1', 'trigger-2']

describe('router output', () => {
  it('parses a valid batch of decisions', () => {
    const output = parseRouterOutput({
      summary: 'one new ticket and one follow-up',
      items: [
        {
          triggerId: 'trigger-1',
          action: 'new',
          title: 'Fix login',
          body: 'the login page is slow',
          scope: 'frontend only',
          reason: 'explicit request',
        },
        { triggerId: 'trigger-2', action: 'attach', ticketId: 'ticket-1', reason: 'same thread' },
      ],
    })
    expect(output.items).toHaveLength(2)
    expect(output.items[0]?.action).toBe('new')
  })

  it('requires a title for new and a ticket id for attach or stop', () => {
    expect(() =>
      parseRouterOutput({ summary: 'x', items: [{ triggerId: 'trigger-1', action: 'new', reason: 'x' }] }),
    ).toThrow(RouterOutputError)
    expect(() =>
      parseRouterOutput({ summary: 'x', items: [{ triggerId: 'trigger-1', action: 'attach', reason: 'x' }] }),
    ).toThrow(RouterOutputError)
    expect(() =>
      parseRouterOutput({ summary: 'x', items: [{ triggerId: 'trigger-1', action: 'stop', reason: 'x' }] }),
    ).toThrow(RouterOutputError)
  })

  it('rejects duplicate trigger ids and unknown actions', () => {
    expect(() =>
      parseRouterOutput({
        summary: 'x',
        items: [
          { triggerId: 'trigger-1', action: 'ignore', reason: 'x' },
          { triggerId: 'trigger-1', action: 'ignore', reason: 'y' },
        ],
      }),
    ).toThrow(RouterOutputError)
    expect(() =>
      parseRouterOutput({ summary: 'x', items: [{ triggerId: 'trigger-1', action: 'merge', reason: 'x' }] }),
    ).toThrow(RouterOutputError)
  })

  it('rejects confidence outside 0..1', () => {
    expect(() =>
      parseRouterOutput({
        summary: 'x',
        items: [{ triggerId: 'trigger-1', action: 'ignore', reason: 'x', confidence: 1.5 }],
      }),
    ).toThrow(RouterOutputError)
  })

  it('requires every batch trigger to have exactly one decision', () => {
    const output = parseRouterOutput({
      summary: 'x',
      items: [{ triggerId: 'trigger-1', action: 'ignore', reason: 'x' }],
    })
    expect(() => validateRouterOutput(output, batch)).toThrow(RouterOutputError)
    expect(() =>
      validateRouterOutput(
        {
          summary: 'x',
          items: [
            { triggerId: 'trigger-1', action: 'ignore', reason: 'x' },
            { triggerId: 'trigger-2', action: 'ignore', reason: 'y' },
          ],
        },
        batch,
      ),
    ).not.toThrow()
  })

  it('rejects decisions for triggers outside the batch', () => {
    const output = parseRouterOutput({
      summary: 'x',
      items: [
        { triggerId: 'trigger-1', action: 'ignore', reason: 'x' },
        { triggerId: 'trigger-9', action: 'ignore', reason: 'y' },
      ],
    })
    expect(() => validateRouterOutput(output, batch)).toThrow(RouterOutputError)
  })
})
