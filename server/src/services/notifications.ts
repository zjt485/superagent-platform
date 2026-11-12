import type { Deps } from './deps.js'
import { channels, type ProjectRow, type TicketRow } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'
import { shortId } from '../domain/ids.js'
import { enqueueOutbox } from './outbox.js'

const limit = (text: string, max = 3500): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

async function channelForTicket(deps: Deps, ticket: TicketRow): Promise<string | null> {
  if (ticket.channelId) return ticket.channelId
  const [channel] = await deps.db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.projectId, ticket.projectId), eq(channels.status, 'active')))
  return channel?.id ?? null
}

export const ticketLabel = (ticket: TicketRow): string => `#${shortId(ticket.id)}「${ticket.title}」`

async function notify(
  deps: Deps,
  ticket: TicketRow,
  kind: string,
  dedupeKey: string,
  text: string,
  replyTo?: string,
): Promise<void> {
  const channelId = await channelForTicket(deps, ticket)
  if (!channelId) return
  await enqueueOutbox(deps, {
    projectId: ticket.projectId,
    channelId,
    kind,
    dedupeKey,
    message: { text: limit(text), ...(replyTo ? { replyToMessageId: replyTo } : {}) },
  })
}

export const notifications = {
  receipt: (deps: Deps, ticket: TicketRow, requester: string, replyTo?: string) =>
    notify(
      deps,
      ticket,
      'receipt',
      `receipt:${ticket.id}`,
      `✅ 已接单 ${ticketLabel(ticket)}\n提交人：${requester}\n正在分析仓库并生成计划，稍后同步进展。`,
      replyTo,
    ),

  planReady: (deps: Deps, ticket: TicketRow, plan: string, approvalRequired: boolean) =>
    notify(
      deps,
      ticket,
      'plan',
      `plan:${ticket.id}:${ticket.lastReportId ?? 'x'}`,
      approvalRequired
        ? `🧭 计划已生成 ${ticketLabel(ticket)}\n${plan}\n\n需要 Maintainer 审批：在群里回复 /approve ${shortId(ticket.id)}，或在控制台批准。`
        : `🧭 计划已生成并开始执行 ${ticketLabel(ticket)}\n${plan}`,
    ),

  approvalNeeded: (deps: Deps, ticket: TicketRow, plan: string) =>
    notify(
      deps,
      ticket,
      'approval',
      `approval:${ticket.id}:${ticket.lastReportId ?? 'x'}`,
      `⏳ 等待计划审批 ${ticketLabel(ticket)}\n${plan}\n\nMaintainer 可回复 /approve ${shortId(ticket.id)}。`,
    ),

  executionStarted: (deps: Deps, ticket: TicketRow) =>
    notify(deps, ticket, 'execution', `execution:${ticket.id}:${ticket.updatedAt.getTime()}`, `🛠 开始执行 ${ticketLabel(ticket)}。`),

  prOpened: (deps: Deps, ticket: TicketRow, prUrl: string, summary: string) =>
    notify(
      deps,
      ticket,
      'pr',
      `pr:${ticket.id}:${ticket.lastReportId ?? prUrl}`,
      `🚀 PR 已创建 ${ticketLabel(ticket)}\n${prUrl}\n${summary}\n等待人工评审，评审意见可直接在该线程回复。`,
    ),

  resumed: (deps: Deps, ticket: TicketRow, text: string) =>
    notify(deps, ticket, 'resumed', `resumed:${ticket.id}:${ticket.updatedAt.getTime()}`, `🔁 已追加到 ${ticketLabel(ticket)}，正在继续处理。\n${text}`),

  failed: (deps: Deps, ticket: TicketRow, reason: string) =>
    notify(
      deps,
      ticket,
      'failed',
      `failed:${ticket.id}:${ticket.lastReportId ?? 'x'}`,
      `⚠️ 执行失败 ${ticketLabel(ticket)}\n原因：${reason}\nMaintainer 可回复 /retry ${shortId(ticket.id)} 重试。`,
    ),

  retrying: (deps: Deps, ticket: TicketRow, attempt: number) =>
    notify(deps, ticket, 'retry', `retry:${ticket.id}:${attempt}`, `🔁 自动重试 ${ticketLabel(ticket)}（第 ${attempt} 次）。`),

  cancelled: (deps: Deps, ticket: TicketRow, actor: string) =>
    notify(deps, ticket, 'cancelled', `cancelled:${ticket.id}`, `🛑 已取消 ${ticketLabel(ticket)}（操作人：${actor}）。`),

  done: (deps: Deps, ticket: TicketRow) =>
    notify(
      deps,
      ticket,
      'done',
      `done:${ticket.id}`,
      `✅ 已完成 ${ticketLabel(ticket)}${ticket.prUrl ? `\nPR：${ticket.prUrl}` : ''}`,
    ),

  completedWithoutPr: (deps: Deps, ticket: TicketRow, summary: string) =>
    notify(
      deps,
      ticket,
      'completed',
      `completed-nopr:${ticket.id}:${ticket.lastReportId ?? 'x'}`,
      `✅ 执行完成但未创建 PR ${ticketLabel(ticket)}\n${summary}`,
    ),

  message: (deps: Deps, project: ProjectRow, channelId: string, text: string, replyTo?: string, dedupeKey?: string) =>
    enqueueOutbox(deps, {
      projectId: project.id,
      channelId,
      kind: 'command',
      ...(dedupeKey ? { dedupeKey } : {}),
      message: { text: limit(text), ...(replyTo ? { replyToMessageId: replyTo } : {}) },
    }),

  ciStatus: (deps: Deps, ticket: TicketRow, status: string, url?: string) =>
    notify(
      deps,
      ticket,
      'ci',
      `ci:${ticket.id}:${status}:${url ?? ''}`,
      `🧪 CI 状态 ${ticketLabel(ticket)}：${status}${url ? `\n${url}` : ''}`,
    ),
}
