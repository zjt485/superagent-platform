/**
 * Status vocabularies from DEVELOPMENT_PLAN.md §11. The database enums mirror
 * these lists; the transition tables below are the only place allowed to
 * change a status.
 */

export const PROJECT_STATUSES = ['draft', 'active', 'paused', 'archived'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const MEMBER_ROLES = ['owner', 'maintainer', 'member', 'viewer'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

export const ROLE_RANK: Record<MemberRole, number> = {
  viewer: 1,
  member: 2,
  maintainer: 3,
  owner: 4,
}

export const atLeast = (role: MemberRole | null | undefined, minimum: MemberRole): boolean =>
  Boolean(role && ROLE_RANK[role] >= ROLE_RANK[minimum])

export const TICKET_STATUSES = [
  'new',
  'triaged',
  'planned',
  'running',
  'waiting_review',
  'done',
  'failed',
  'cancelled',
] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export const TERMINAL_TICKET_STATUSES: readonly TicketStatus[] = ['done', 'failed', 'cancelled']
export const ACTIVE_TICKET_STATUSES: readonly TicketStatus[] = ['new', 'triaged', 'planned', 'running', 'waiting_review']

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running']

export const RUN_KINDS = ['plan', 'execute'] as const
export type RunKind = (typeof RUN_KINDS)[number]

/** Dual-agent session turns replace the old plan/execute Runs. */
export const TURN_KINDS = ['eval', 'execute', 'resume'] as const
export type TurnKind = (typeof TURN_KINDS)[number]

export const TURN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'] as const
export type TurnStatus = (typeof TURN_STATUSES)[number]

export const CHANNEL_PROVIDERS = ['feishu', 'wecom'] as const
export type ChannelProvider = (typeof CHANNEL_PROVIDERS)[number]

export const PROJECT_STATUS_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  draft: ['active', 'archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: [],
}

export const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  new: ['triaged', 'running', 'waiting_review', 'failed', 'cancelled'],
  triaged: ['planned', 'running', 'failed', 'cancelled'],
  planned: ['running', 'failed', 'cancelled'],
  running: ['waiting_review', 'planned', 'failed', 'cancelled'],
  waiting_review: ['running', 'done', 'failed', 'cancelled'],
  done: ['running', 'cancelled'],
  failed: ['running', 'triaged', 'cancelled'],
  cancelled: ['running'],
}

export function canTransitionTicket(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to)
}

export function assertTicketTransition(from: TicketStatus, to: TicketStatus): void {
  if (!canTransitionTicket(from, to)) {
    throw new Error(`Illegal ticket transition: ${from} -> ${to}`)
  }
}

export const RUN_TERMINAL_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'timeout']

export const isRunTerminal = (status: RunStatus): boolean => RUN_TERMINAL_STATUSES.includes(status)
