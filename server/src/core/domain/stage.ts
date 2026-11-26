import type { StageEvent, TicketStage, TicketStatus } from './types.js'

const TRANSITIONS: Record<TicketStage, Record<string, TicketStage>> = {
  queued: { dispatch: 'working', input: 'queued', stop: 'cancelled' },
  working: {
    progress: 'working',
    'waiting:true': 'plan_review',
    'waiting:false': 'idle',
    approval_requested: 'waiting_approval',
    'ready:true': 'review',
    'ready:false': 'answer',
    blocked: 'blocked',
    failed: 'failed',
    input: 'working',
    stop: 'cancelled',
  },
  plan_review: { approve: 'queued', reject: 'cancelled', stop: 'cancelled' },
  waiting_approval: { approve: 'queued', reject: 'queued', revise: 'queued', stop: 'cancelled' },
  idle: { input: 'queued', dispatch: 'working', stop: 'cancelled' },
  review: { input: 'queued', merge: 'done', close: 'cancelled', stop: 'cancelled' },
  answer: { input: 'queued', close: 'done', stop: 'cancelled' },
  blocked: { input: 'queued', retry: 'queued', stop: 'cancelled' },
  failed: { input: 'queued', retry: 'queued', stop: 'cancelled' },
  done: { input: 'queued' },
  cancelled: {},
}

const STATUS_BY_STAGE: Record<TicketStage, TicketStatus> = {
  queued: 'triaged',
  working: 'running',
  plan_review: 'planned',
  waiting_approval: 'planned',
  idle: 'waiting_review',
  review: 'waiting_review',
  answer: 'waiting_review',
  blocked: 'waiting_review',
  failed: 'failed',
  done: 'done',
  cancelled: 'cancelled',
}

/** Stable key for an event, including the branch-defining payload. */
export function stageEventKey(event: StageEvent): string {
  switch (event.type) {
    case 'waiting':
      return `waiting:${event.plan}`
    case 'ready':
      return `ready:${event.codeChanged}`
    default:
      return event.type
  }
}

export class InvalidStageTransition extends Error {
  readonly from: TicketStage
  readonly event: StageEvent

  constructor(from: TicketStage, event: StageEvent) {
    super(`${from} + ${stageEventKey(event)}`)
    this.name = 'InvalidStageTransition'
    this.from = from
    this.event = event
  }
}

/** Advance a ticket stage; invalid transitions throw. */
export function nextStage(from: TicketStage, event: StageEvent): TicketStage {
  const to = TRANSITIONS[from][stageEventKey(event)]
  if (to === undefined) throw new InvalidStageTransition(from, event)
  return to
}

/** Cancelled is the only terminal stage; done can be resumed by new input. */
export function isTerminalStage(stage: TicketStage): boolean {
  return stage === 'cancelled'
}

/** Project a core stage onto the legacy tickets.status column. */
export function statusOfStage(stage: TicketStage): TicketStatus {
  return STATUS_BY_STAGE[stage]
}
