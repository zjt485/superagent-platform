/** Core domain types shared by the Router, Dispatcher and Worker. */

export type TicketStage =
  | 'queued'
  | 'working'
  | 'plan_review'
  | 'idle'
  | 'review'
  | 'answer'
  | 'blocked'
  | 'failed'
  | 'done'
  | 'cancelled'

/** Legacy console projection stored in tickets.status. */
export type TicketStatus =
  | 'new'
  | 'triaged'
  | 'planned'
  | 'running'
  | 'waiting_review'
  | 'done'
  | 'failed'
  | 'cancelled'

export type StageEvent =
  | { type: 'dispatch' }
  | { type: 'progress' }
  | { type: 'waiting'; plan: boolean }
  | { type: 'ready'; codeChanged: boolean }
  | { type: 'blocked' }
  | { type: 'failed' }
  | { type: 'approve' }
  | { type: 'reject' }
  | { type: 'input' }
  | { type: 'retry' }
  | { type: 'stop' }
  | { type: 'merge' }
  | { type: 'close' }

export type TriggerAddress = 'mention' | 'direct' | 'ambient'

export type TriggerDisposition =
  | 'pending'
  | 'attached'
  | 'new_ticket'
  | 'ignored'
  | 'stopped'
  | 'command'
  | 'pending_review'

export type DecisionAction = 'new' | 'attach' | 'ignore' | 'stop' | 'command'

export type ReportStatus = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'

export type InputKind = 'message' | 'approval' | 'policy' | 'note' | 'system'

export type TurnStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout'

export interface CoreTrigger {
  id: string
  projectId: string
  channelId: string | null
  provider: string
  externalId: string
  threadKey: string
  senderId: string | null
  senderName: string | null
  address: TriggerAddress
  text: string
  at: Date
  disposition: TriggerDisposition
}

export interface DecisionItem {
  triggerId: string
  action: DecisionAction
  ticketId?: string
  title?: string
  body?: string
  scope?: string
  planApproval?: 'required' | 'auto'
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  reason: string
  confidence?: number
  payload?: Record<string, unknown>
}

export interface RouterUsage {
  promptTokens: number
  outputTokens: number
  totalTokens: number
  cost?: number
}

export interface RouterOutput {
  items: DecisionItem[]
  summary: string
  usage?: RouterUsage
}

export interface Report {
  status: ReportStatus
  summary: string
  plan?: string
  attentionQuestion?: string
  branch?: string
  prUrl?: string
  changedFiles?: string[]
  tokens?: number
  cost?: number
  raw?: unknown
}
