import { stripMentions } from './message.js'
import type { MemberRole, ProjectStatus, TicketStatus } from './status.js'
import { atLeast } from './status.js'
import type { ProjectPolicy } from './policy.js'

export const COMMANDS = ['status', 'cancel', 'retry', 'approve', 'bind', 'help'] as const
export type CommandName = (typeof COMMANDS)[number] | 'unknown'

export interface ParsedCommand {
  name: CommandName
  arg: string
  raw: string
}

/**
 * Recognizes `/command` in a message. Mentions are removed first, so both
 * `@bot /status` and `/status` (in a ticket thread) parse the same way.
 * Returns null when the message is not a command.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const cleaned = stripMentions(text)
  const match = /^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(cleaned)
  if (!match) return null
  const name = (match[1] ?? '').toLowerCase()
  const arg = (match[2] ?? '').trim()
  const known = (COMMANDS as readonly string[]).includes(name)
  return { name: known ? (name as CommandName) : 'unknown', arg, raw: cleaned }
}

/** Commands any member (including viewers) may use. */
const READ_ONLY_COMMANDS: readonly CommandName[] = ['status', 'help']

export const commandNeedsRole: Record<Exclude<CommandName, 'unknown'>, MemberRole> = {
  status: 'viewer',
  help: 'viewer',
  cancel: 'maintainer',
  retry: 'maintainer',
  approve: 'maintainer',
  bind: 'maintainer',
}

export type IgnoreReason =
  | 'bot_message'
  | 'empty_message'
  | 'not_project_chat'
  | 'not_member'
  | 'project_archived'
  | 'project_paused'
  | 'thread_replies_disabled'
  | 'ticket_closed'
  | 'not_mentioned'

export type IntakeDecision =
  | { action: 'ignored'; reason: IgnoreReason }
  | {
      action: 'command'
      command: CommandName
      arg: string
      authorized: boolean
      reason?: 'unknown_command' | 'insufficient_role' | 'project_paused'
    }
  | { action: 'ticket_created'; reason?: undefined }
  | { action: 'ticket_appended'; ticketId: string; reopen: boolean }

export interface IntakeContext {
  isBotMessage: boolean
  /** The channel binding, if this chat belongs to a project on this platform. */
  channel: { projectId: string; projectStatus: ProjectStatus } | null
  memberRole: MemberRole | null
  command: ParsedCommand | null
  mentionBot: boolean
  /** An active (non-terminal, or recently closed) ticket on the same thread. */
  threadTicket: { id: string; status: TicketStatus } | null
  policy: ProjectPolicy | null
}

const REOPENABLE: readonly TicketStatus[] = ['waiting_review', 'done']

/**
 * The whole routing rule set of this version (§8.1): deterministic, no model.
 * Precedence: bot/empty filter → chat binding → membership → commands →
 * paused/archived → ticket thread → @bot → ignore.
 */
export function decideIntake(context: IntakeContext): IntakeDecision {
  if (context.isBotMessage) return { action: 'ignored', reason: 'bot_message' }
  if (!context.channel) return { action: 'ignored', reason: 'not_project_chat' }
  if (context.channel.projectStatus === 'archived') return { action: 'ignored', reason: 'project_archived' }
  if (!context.memberRole) return { action: 'ignored', reason: 'not_member' }

  if (context.command) {
    const name = context.command.name
    if (name === 'unknown') {
      return { action: 'command', command: name, arg: context.command.arg, authorized: false, reason: 'unknown_command' }
    }
    const required = commandNeedsRole[name]
    const authorized = atLeast(context.memberRole, required)
    const pausedBlocks = context.channel.projectStatus === 'paused' && !READ_ONLY_COMMANDS.includes(name)
    return {
      action: 'command',
      command: name,
      arg: context.command.arg,
      authorized: authorized && !(pausedBlocks && name !== 'cancel'),
      reason: !authorized ? 'insufficient_role' : pausedBlocks && name !== 'cancel' ? 'project_paused' : undefined,
    }
  }

  if (context.channel.projectStatus === 'paused') return { action: 'ignored', reason: 'project_paused' }

  if (context.threadTicket) {
    const status = context.threadTicket.status
    if (status === 'cancelled' || status === 'failed') {
      return context.policy?.allowThreadReplies ? { action: 'ignored', reason: 'ticket_closed' } : { action: 'ignored', reason: 'ticket_closed' }
    }
    if (status !== 'done' || context.policy?.allowThreadReplies) {
      if (!context.policy?.allowThreadReplies && !context.mentionBot) {
        return { action: 'ignored', reason: 'thread_replies_disabled' }
      }
      return { action: 'ticket_appended', ticketId: context.threadTicket.id, reopen: REOPENABLE.includes(status) }
    }
  }

  if (context.mentionBot) return { action: 'ticket_created' }
  return { action: 'ignored', reason: 'not_mentioned' }
}
