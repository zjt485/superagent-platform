import type { TicketStage, TriggerAddress } from '../domain/types.js'

export interface BoardProject {
  id: string
  name: string
  planApproval: 'required' | 'auto'
  allowThreadReplies: boolean
}

export interface BoardTicket {
  shortName: string
  title: string
  stage: TicketStage
  lastReport?: string
}

export interface BoardTrigger {
  id: string
  senderName: string | null
  text: string
  at: string
  address: TriggerAddress
}

export interface BoardInput {
  project: BoardProject
  thread: { key: string; summary: string | null }
  tickets: BoardTicket[]
  recent: BoardTrigger[]
  batch: BoardTrigger[]
  waitingQuestions?: Array<{ shortName: string; question: string }>
}

export interface RenderBoardOptions {
  maxTextChars?: number
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function senderOf(trigger: BoardTrigger): string {
  return trigger.senderName ?? 'unknown'
}

/** Render the state board the Router model reads before deciding. */
export function renderBoard(input: BoardInput, options: RenderBoardOptions = {}): string {
  const max = options.maxTextChars ?? 500
  const lines: string[] = []

  lines.push('## Project')
  lines.push(`${input.project.name} (${input.project.id})`)
  lines.push(
    `plan approval: ${input.project.planApproval}; thread replies: ${input.project.allowThreadReplies ? 'allowed' : 'disabled'}`,
  )
  lines.push('')

  lines.push('## Thread')
  lines.push(input.thread.summary === null || input.thread.summary.trim() === '' ? '(no summary)' : clip(input.thread.summary, max * 4))
  lines.push('')

  lines.push('## Open tickets')
  if (input.tickets.length === 0) {
    lines.push('(no open tickets)')
  } else {
    for (const ticket of input.tickets) {
      const report = ticket.lastReport === undefined ? '' : ` — last report: ${clip(ticket.lastReport, max)}`
      lines.push(`- ${ticket.shortName} [${ticket.stage}] ${clip(ticket.title, max)}${report}`)
    }
  }
  lines.push('')

  if (input.waitingQuestions !== undefined && input.waitingQuestions.length > 0) {
    lines.push('## Waiting questions')
    for (const question of input.waitingQuestions) {
      lines.push(`- ${question.shortName}: ${clip(question.question, max)}`)
    }
    lines.push('')
  }

  lines.push('## Recent messages')
  if (input.recent.length === 0) {
    lines.push('(no recent messages)')
  } else {
    for (const trigger of input.recent) {
      lines.push(`- [${trigger.at}] ${senderOf(trigger)} (${trigger.address}): ${clip(trigger.text, max)}`)
    }
  }
  lines.push('')

  lines.push('## This batch (one decision per trigger)')
  for (const trigger of input.batch) {
    lines.push(`- id=${trigger.id} [${trigger.at}] ${senderOf(trigger)} (${trigger.address}): ${clip(trigger.text, max)}`)
  }

  return lines.join('\n')
}
