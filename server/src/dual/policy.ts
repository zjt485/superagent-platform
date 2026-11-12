import { createHash } from 'node:crypto'
import type { ProjectPolicy } from '../domain/policy.js'
import type { ExecutorReportOutput, TicketStage } from './types.js'

export type { TicketStage }

/** A stable identifier for the authorization/assessment rules a Mandate used. */
export function policyVersion(policy: ProjectPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16)
}

export function stageFromReport(report: Pick<ExecutorReportOutput, 'status'>): TicketStage {
  switch (report.status) {
    case 'progress':
      return 'working'
    case 'waiting':
      return 'idle'
    case 'ready':
      return 'review'
    case 'blocked':
      return 'blocked'
    case 'failed':
      return 'failed'
    case 'dropped':
      return 'cancelled'
  }
}

/** Legacy `tickets.status` projection used by the console during the rewrite. */
export function statusFromStage(stage: TicketStage): 'new' | 'triaged' | 'planned' | 'running' | 'waiting_review' | 'done' | 'failed' | 'cancelled' {
  switch (stage) {
    case 'queued':
      return 'triaged'
    case 'working':
    case 'idle':
    case 'answer':
      return 'running'
    case 'plan_review':
      return 'planned'
    case 'review':
      return 'waiting_review'
    case 'blocked':
    case 'failed':
      return 'failed'
    case 'done':
      return 'done'
    case 'cancelled':
      return 'cancelled'
  }
}

export const isEndedStage = (stage: string | null | undefined): boolean => stage === 'done' || stage === 'cancelled'

export const isStageAwaitingPerson = (stage: string | null | undefined): boolean =>
  stage === 'review' || stage === 'blocked' || stage === 'failed' || stage === 'answer' || stage === 'plan_review' || stage === 'idle'
