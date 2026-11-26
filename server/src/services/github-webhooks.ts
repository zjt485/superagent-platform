import { and, desc, eq } from 'drizzle-orm'
import type { CoreContext } from '../core/operations.js'
import { deliverTicketInput, markTicketClosed, markTicketMerged } from '../core/operations.js'
import { audit } from './audit.js'
import { newId } from '../domain/ids.js'
import { messages, projects, repos, tickets, type ProjectRow, type TicketRow } from '../db/schema.js'
import { notifications } from './notifications.js'
import { isUniqueViolation } from '../db/errors.js'

type Json = Record<string, unknown>
const asRecord = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {})

async function findTicket(ctx: CoreContext, payload: Json, pr: Json): Promise<TicketRow | null> {
  const repoFullName = typeof asRecord(payload.repository).full_name === 'string' ? (asRecord(payload.repository).full_name as string) : ''
  const prUrl = typeof pr.html_url === 'string' ? pr.html_url : ''
  const head = typeof asRecord(pr.head).ref === 'string' ? (asRecord(pr.head).ref as string) : ''
  if (prUrl) {
    const [direct] = await ctx.db.select().from(tickets).where(eq(tickets.prUrl, prUrl)).limit(1)
    if (direct) return direct
  }
  if (!repoFullName) return null
  const [repo] = await ctx.db.select().from(repos).where(eq(repos.fullName, repoFullName))
  if (!repo) return null
  if (head) {
    const [byBranch] = await ctx.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.projectId, repo.projectId), eq(tickets.branch, head)))
      .orderBy(desc(tickets.createdAt))
      .limit(1)
    if (byBranch) return byBranch
  }
  return null
}

async function projectOf(ctx: CoreContext, projectId: string): Promise<ProjectRow | null> {
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId))
  return project ?? null
}

async function recordComment(
  ctx: CoreContext,
  ticket: TicketRow,
  input: { id: string; body: string; login: string; url?: string },
): Promise<void> {
  try {
    await ctx.db.insert(messages).values({
      id: newId(),
      projectId: ticket.projectId,
      channelId: ticket.channelId,
      provider: 'github',
      providerMessageId: `github-comment:${input.id}`,
      senderId: null,
      externalSenderId: input.login,
      senderName: input.login,
      text: input.body.slice(0, 20_000),
      threadKey: ticket.threadKey,
      replyToMessageId: null,
      isBot: false,
      raw: { url: input.url ?? null },
      createdAt: ctx.now(),
    })
  } catch (error) {
    // Already recorded: do not deliver the same comment twice.
    if (isUniqueViolation(error)) return
    throw error
  }
  const project = await projectOf(ctx, ticket.projectId)
  if (project) {
    await deliverTicketInput(ctx, project, ticket, null, `PR 评论（${input.login}）：${input.body}`, true, 'person')
  }
}

/** Handles the GitHub events the service consumes (FR-09, §4.5). */
export async function handleGithubWebhook(
  ctx: CoreContext,
  event: string,
  payload: Json,
  deliveryId: string,
): Promise<{ handled: string }> {
  const action = typeof payload.action === 'string' ? payload.action : ''
  if (event === 'pull_request') {
    const pr = asRecord(payload.pull_request)
    const ticket = await findTicket(ctx, payload, pr)
    if (!ticket) {
      await audit(ctx, { action: 'github.unmatched', metadata: { event, deliveryId, action } })
      return { handled: 'unmatched' }
    }
    if (action === 'closed') {
      if (pr.merged === true) {
        await markTicketMerged(ctx, ticket.id, typeof pr.html_url === 'string' ? pr.html_url : null)
        await audit(ctx, {
          projectId: ticket.projectId,
          action: 'github.pr_merged',
          target: `ticket:${ticket.id}`,
          metadata: { prUrl: pr.html_url ?? null },
        })
        return { handled: 'merged' }
      }
      if (ticket.stage !== 'done' && ticket.stage !== 'cancelled') {
        await markTicketClosed(ctx, ticket.id, typeof pr.html_url === 'string' ? pr.html_url : null)
        await audit(ctx, { projectId: ticket.projectId, action: 'github.pr_closed', target: `ticket:${ticket.id}` })
      }
      return { handled: 'closed' }
    }
    if (action === 'reopened') {
      await audit(ctx, { projectId: ticket.projectId, action: 'github.pr_reopened', target: `ticket:${ticket.id}` })
      return { handled: 'reopened' }
    }
    return { handled: 'ignored' }
  }

  if (event === 'issue_comment' || event === 'pull_request_review_comment') {
    if (action !== 'created') return { handled: 'ignored' }
    const issue = asRecord(payload.issue)
    const pr = asRecord(payload.pull_request)
    const comment = asRecord(payload.comment)
    if (event === 'issue_comment' && !issue.pull_request) return { handled: 'ignored' }
    const sender = asRecord(payload.sender)
    if (sender.type === 'Bot') return { handled: 'ignored' }
    const ticket =
      event === 'issue_comment'
        ? await findTicket(ctx, payload, { ...issue, html_url: issue.html_url, head: { ref: '' } })
        : await findTicket(ctx, payload, { ...pr, html_url: pr.html_url, head: pr.head })
    if (!ticket) {
      await audit(ctx, { action: 'github.unmatched', metadata: { event, deliveryId } })
      return { handled: 'unmatched' }
    }
    const commentId = String(comment.id ?? '')
    if (!commentId) return { handled: 'ignored' }
    await recordComment(ctx, ticket, {
      id: commentId,
      body: String(comment.body ?? ''),
      login: String(asRecord(comment.user).login ?? 'github-user'),
      ...(typeof comment.html_url === 'string' ? { url: comment.html_url } : {}),
    })
    await audit(ctx, {
      projectId: ticket.projectId,
      action: 'github.comment',
      target: `ticket:${ticket.id}`,
      metadata: { commentId },
    })
    return { handled: 'comment-delivered' }
  }

  if (event === 'check_suite' || event === 'check_run') {
    const suite = asRecord(event === 'check_suite' ? payload.check_suite : payload.check_run)
    const prs = Array.isArray(suite.pull_requests) ? suite.pull_requests : []
    const pr = asRecord(prs[0])
    if (!pr || action !== 'completed') return { handled: 'ignored' }
    const repository = asRecord(payload.repository)
    const repoFullName = typeof repository.full_name === 'string' ? repository.full_name : ''
    const number = pr.number
    const prHtmlUrl =
      repoFullName && typeof number === 'number' ? `${ctx.config.GITHUB_WEB_BASE}/${repoFullName}/pull/${number}` : ''
    const ticket = await findTicket(ctx, payload, { html_url: prHtmlUrl, head: pr.head })
    if (!ticket) return { handled: 'unmatched' }
    const conclusion = String(suite.conclusion ?? suite.status ?? 'unknown')
    await notifications.ciStatus(ctx, ticket, conclusion, typeof suite.html_url === 'string' ? suite.html_url : undefined)
    await audit(ctx, {
      projectId: ticket.projectId,
      action: 'github.ci_status',
      target: `ticket:${ticket.id}`,
      metadata: { conclusion },
    })
    return { handled: 'ci' }
  }

  return { handled: 'ignored' }
}
