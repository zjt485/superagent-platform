import { describe, expect, it } from 'vitest'
import { decideIntake, parseCommand } from '../src/domain/intake.js'
import { DEFAULT_POLICY } from '../src/domain/policy.js'
import { stripMentions, ticketTitle } from '../src/domain/message.js'

describe('command parsing', () => {
  it('parses commands with or without a mention', () => {
    expect(parseCommand('@_user_1 /status')).toEqual({ name: 'status', arg: '', raw: '/status' })
    expect(parseCommand('/bind demo-project')).toEqual({ name: 'bind', arg: 'demo-project', raw: '/bind demo-project' })
    expect(parseCommand('@_user_1 帮我看下 /status')).toBeNull()
    expect(parseCommand('/nope')).toMatchObject({ name: 'unknown' })
  })
})

describe('mention router', () => {
  const base = {
    isBotMessage: false,
    channel: { projectId: 'p1', projectStatus: 'active' as const },
    memberRole: 'member' as const,
    command: null,
    mentionBot: false,
    threadTicket: null,
    policy: DEFAULT_POLICY,
  }

  it('ignores non-mentions in a project chat', () => {
    expect(decideIntake(base)).toEqual({ action: 'ignored', reason: 'not_mentioned' })
  })

  it('ignores messages outside a bound chat', () => {
    expect(decideIntake({ ...base, channel: null, mentionBot: true })).toEqual({ action: 'ignored', reason: 'not_project_chat' })
  })

  it('ignores non-members', () => {
    expect(decideIntake({ ...base, memberRole: null, mentionBot: true })).toEqual({ action: 'ignored', reason: 'not_member' })
  })

  it('creates a ticket for an @bot message from a member', () => {
    expect(decideIntake({ ...base, mentionBot: true })).toEqual({ action: 'ticket_created' })
  })

  it('appends thread replies without a mention when the project allows it', () => {
    expect(decideIntake({ ...base, threadTicket: { id: 't1', status: 'waiting_review' } })).toEqual({
      action: 'ticket_appended',
      ticketId: 't1',
      reopen: true,
    })
  })

  it('ignores thread replies without a mention when disabled', () => {
    const policy = { ...DEFAULT_POLICY, allowThreadReplies: false }
    expect(decideIntake({ ...base, threadTicket: { id: 't1', status: 'running' }, policy })).toEqual({
      action: 'ignored',
      reason: 'thread_replies_disabled',
    })
  })

  it('ignores messages in paused projects but still allows read-only commands', () => {
    const paused = { ...base, channel: { projectId: 'p1', projectStatus: 'paused' as const } }
    expect(decideIntake({ ...paused, mentionBot: true })).toEqual({ action: 'ignored', reason: 'project_paused' })
    expect(decideIntake({ ...paused, command: { name: 'status', arg: '', raw: '/status' } })).toMatchObject({
      action: 'command',
      authorized: true,
    })
  })

  it('requires maintainer for cancel/retry/approve', () => {
    for (const name of ['cancel', 'retry', 'approve'] as const) {
      const decision = decideIntake({ ...base, command: { name, arg: '', raw: `/${name}` }, memberRole: 'member' })
      expect(decision).toMatchObject({ action: 'command', authorized: false, reason: 'insufficient_role' })
    }
    const allowed = decideIntake({ ...base, command: { name: 'cancel', arg: '', raw: '/cancel' }, memberRole: 'maintainer' })
    expect(allowed).toMatchObject({ action: 'command', authorized: true })
  })

  it('filters bot messages before anything else', () => {
    expect(decideIntake({ ...base, isBotMessage: true, mentionBot: true })).toEqual({ action: 'ignored', reason: 'bot_message' })
  })
})

describe('message helpers', () => {
  it('removes Feishu mention placeholders and truncates titles', () => {
    expect(stripMentions('@_user_1 修复 @_user_2 登录')).toBe('修复 登录')
    expect(ticketTitle('@_user_1 把登录页的报错文案改成中文')).toBe('把登录页的报错文案改成中文')
    expect(ticketTitle('a'.repeat(200)).length).toBe(120)
  })
})
