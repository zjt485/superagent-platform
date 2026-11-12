import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Deps } from '../services/deps.js'
import type { QueuePort } from '../domain/queue.js'
import {
  agentSessions,
  approvals,
  assignments,
  channels,
  evaluations,
  identities,
  mandates,
  projects,
  reports,
  sessionTurns,
  ticketInputs,
  ticketSubscriptions,
  tickets,
  triggers,
  users,
  type ChannelRow,
  type ProjectRow,
  type TicketRow,
  type UserRow,
} from '../db/schema.js'
import { newId, shortId } from '../domain/ids.js'
import { stripMentions, ticketTitle } from '../domain/message.js'
import { parsePolicy, type ProjectPolicy } from '../domain/policy.js'
import { atLeast, type ChannelProvider, type MemberRole } from '../domain/status.js'
import { audit } from '../services/audit.js'
import { conflict, notFound } from '../errors.js'
import { notifications } from '../services/notifications.js'
import { getMembership } from '../services/access.js'
import { enqueueOutbox } from '../services/outbox.js'
import { tokensUsedToday } from '../services/usage.js'
import { isUniqueViolation } from '../db/errors.js'
import { commandNeedsRole, type ParsedCommand } from '../domain/intake.js'
import type { ExecutorReportOutput, MainDecisionOutput, MainTurnPacket, ExecutorTurnPacket, TicketCard } from './types.js'
import { MAIN_DECISION_OUTPUT, EXECUTOR_REPORT_OUTPUT } from './types.js'
import { policyVersion, statusFromStage, type TicketStage } from './policy.js'
import {
  activeExecutorTurn,
  appendSessionMessage,
  cancelQueuedTurns,
  createTurn,
  ensureExecutorSession,
  ensureMainSession,
  findStaleTurns,
  finishTurn,
  recentTranscript,
  runningTurnForSession,
} from './sessions.js'

export interface DualContext extends Deps {
  queue: QueuePort
}

export interface TriggerInput {
  provider: ChannelProvider
  externalId: string
  chatId: string
  threadKey: string
  senderExternalId: string
  senderName?: string | null
  isBot?: boolean
  text: string
  mentionBot: boolean
  replyTo?: string | null
  messageId?: string | null
  command?: ParsedCommand | null
  raw?: unknown
}

export interface ReceiveResult {
  action: 'duplicate' | 'ignored' | 'command' | 'evaluation' | 'input'
  reason?: string
  ticketId?: string
  ticketIds?: string[]
  evaluationId?: string
  turnId?: string
}

const HELP_TEXT = [
  '可用命令：',
  '/status [工单号] 查看工单',
  '/cancel [工单号] 停止工单（Maintainer+）',
  '/retry [工单号] 重试（Maintainer+）',
  '/approve [工单号] 批准计划（Maintainer+）',
  '/help 查看帮助',
  '直接 @我 描述需求；工单线程内的回复会作为 Input 交给该工单的 Executor。',
].join('\n')

const DEFAULT_REPLY = '已接单，正在安排 Executor 分析。'

async function userForTrigger(deps: Deps, provider: string, externalId: string): Promise<UserRow | null> {
  const [row] = await deps.db
    .select({ user: users })
    .from(users)
    .innerJoin(identities, eq(identities.userId, users.id))
    .where(and(eq(identities.provider, provider), eq(identities.externalId, externalId)))
  return row?.user ?? null
}

async function latestTicketForThread(deps: Deps, projectId: string, channelId: string | null, threadKey: string): Promise<TicketRow | null> {
  const conditions = [eq(tickets.projectId, projectId), eq(tickets.threadKey, threadKey)]
  if (channelId) conditions.push(eq(tickets.channelId, channelId))
  const [row] = await deps.db
    .select()
    .from(tickets)
    .where(and(...conditions))
    .orderBy(desc(tickets.createdAt))
    .limit(1)
  return row ?? null
}

async function latestOpenTicket(deps: Deps, projectId: string, channelId: string): Promise<TicketRow | null> {
  const [row] = await deps.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), eq(tickets.channelId, channelId), inArray(tickets.status, ['new', 'triaged', 'planned', 'running', 'waiting_review'])))
    .orderBy(desc(tickets.createdAt))
    .limit(1)
  return row ?? null
}

async function resolveTicket(deps: Deps, projectId: string, channel: ChannelRow, threadKey: string, arg: string): Promise<TicketRow | null> {
  if (arg) {
    const ref = arg.replace(/^#/, '').toLowerCase()
    const rows = await deps.db.select().from(tickets).where(eq(tickets.projectId, projectId)).orderBy(desc(tickets.createdAt)).limit(300)
    const found = rows.find((row) => row.id === ref || row.id.startsWith(ref) || shortId(row.id).startsWith(ref))
    if (found) return found
  }
  return (await latestTicketForThread(deps, projectId, channel.id, threadKey)) ?? (await latestOpenTicket(deps, projectId, channel.id))
}

async function replyToChannel(ctx: DualContext, project: ProjectRow, channel: ChannelRow, triggerId: string, text: string, replyTo?: string | null): Promise<void> {
  await enqueueOutbox(ctx, {
    projectId: project.id,
    channelId: channel.id,
    kind: 'command',
    dedupeKey: `dual-reply:${triggerId}`,
    message: { text: text.slice(0, 3500), ...(replyTo ? { replyToMessageId: replyTo } : {}) },
  })
}

function policyOf(project: ProjectRow): ProjectPolicy {
  return parsePolicy(project.policyJson)
}

export async function receiveTrigger(ctx: DualContext, input: TriggerInput): Promise<ReceiveResult> {
  const channel = await ctx.db
    .select()
    .from(channels)
    .where(and(eq(channels.provider, input.provider), eq(channels.externalChatId, input.chatId), eq(channels.status, 'active')))
    .limit(1)
    .then((rows) => rows[0] ?? null)
  if (!channel) return { action: 'ignored', reason: 'not_project_chat' }
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, channel.projectId))
  if (!project) return { action: 'ignored', reason: 'not_project_chat' }

  const triggerUserId = await userIdForIdentity(ctx, input.provider, input.senderExternalId)
  const triggerId = newId()
  const text = stripMentions(input.text) || input.text.trim()
  try {
    await ctx.db.insert(triggers).values({
      id: triggerId,
      projectId: project.id,
      channelId: channel.id,
      messageId: input.messageId ?? null,
      provider: input.provider,
      externalId: input.externalId,
      threadKey: input.threadKey,
      actorUserId: triggerUserId,
      actorExternalId: input.senderExternalId,
      actorName: input.senderName ?? null,
      text: text.slice(0, 20_000),
      isBot: input.isBot ?? false,
      mentionedBot: input.mentionBot,
      replyTo: input.replyTo ?? null,
      raw: input.raw ?? null,
      createdAt: ctx.now(),
    })
  } catch (error) {
    if (isUniqueViolation(error)) return { action: 'duplicate' }
    throw error
  }

  const role = triggerUserId ? await getMembership(ctx, project.id, triggerUserId) : null

  if (input.command) {
    const result = await handleCommand(ctx, {
      project,
      channel,
      triggerId,
      threadKey: input.threadKey,
      command: input.command,
      userId: triggerUserId,
      userName: input.senderName ?? null,
      role,
      replyTo: input.replyTo ?? null,
    })
    await audit(ctx, {
      projectId: project.id,
      actorId: triggerUserId,
      actorLabel: input.senderName ?? null,
      action: 'command.received',
      target: `trigger:${triggerId}`,
      metadata: { command: input.command.name, result: result.reason ?? null },
    })
    return result
  }

  if (input.isBot) return { action: 'ignored', reason: 'bot_message' }
  if (!role) return { action: 'ignored', reason: 'not_member' }
  if (project.status !== 'active') return { action: 'ignored', reason: project.status === 'paused' ? 'project_paused' : 'project_archived' }

  const subscriptions = await ctx.db
    .select()
    .from(ticketSubscriptions)
    .where(
      and(
        eq(ticketSubscriptions.projectId, project.id),
        eq(ticketSubscriptions.provider, input.provider),
        eq(ticketSubscriptions.threadKey, input.threadKey),
      ),
    )
  if (subscriptions.length > 0) {
    const delivered: string[] = []
    for (const subscription of subscriptions) {
      const [ticket] = await ctx.db.select().from(tickets).where(eq(tickets.id, subscription.ticketId))
      if (!ticket) continue
      await createInput(ctx, project, ticket, triggerId, text, !input.isBot)
      delivered.push(ticket.id)
    }
    return { action: 'input', ticketIds: delivered, reason: 'subscribed_thread' }
  }

  if (!input.mentionBot) return { action: 'ignored', reason: 'not_mentioned' }
  return createEvaluation(ctx, project, channel, triggerId, input.threadKey)
}

async function userIdForIdentity(deps: Deps, provider: string, externalId: string): Promise<string | null> {
  const [row] = await deps.db
    .select({ userId: identities.userId })
    .from(identities)
    .where(and(eq(identities.provider, provider), eq(identities.externalId, externalId)))
  return row?.userId ?? null
}

async function createEvaluation(
  ctx: DualContext,
  project: ProjectRow,
  channel: ChannelRow,
  triggerId: string,
  threadKey: string,
): Promise<ReceiveResult> {
  const version = policyVersion(policyOf(project))
  const [active] = await ctx.db
    .select()
    .from(evaluations)
    .where(
      and(
        eq(evaluations.projectId, project.id),
        eq(evaluations.threadKey, threadKey),
        inArray(evaluations.status, ['queued', 'running']),
      ),
    )
    .limit(1)

  let evaluationId = active?.id
  if (active) {
    await ctx.db
      .update(evaluations)
      .set({ triggerIds: sql`${evaluations.triggerIds} || ${JSON.stringify([triggerId])}::jsonb` })
      .where(eq(evaluations.id, active.id))
  } else {
    evaluationId = newId()
    try {
      await ctx.db.insert(evaluations).values({
        id: evaluationId,
        projectId: project.id,
        channelId: channel.id,
        threadKey,
        policyVersion: version,
        status: 'queued',
        triggerIds: [triggerId],
        createdAt: ctx.now(),
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      const [racing] = await ctx.db
        .select()
        .from(evaluations)
        .where(and(eq(evaluations.projectId, project.id), eq(evaluations.threadKey, threadKey), inArray(evaluations.status, ['queued', 'running'])))
        .limit(1)
      if (!racing) throw error
      evaluationId = racing.id
      await ctx.db
        .update(evaluations)
        .set({ triggerIds: sql`${evaluations.triggerIds} || ${JSON.stringify([triggerId])}::jsonb` })
        .where(eq(evaluations.id, racing.id))
    }
  }
  await ctx.db.update(triggers).set({ evaluationId }).where(eq(triggers.id, triggerId))

  const [existingTurn] = await ctx.db
    .select()
    .from(sessionTurns)
    .where(and(eq(sessionTurns.evaluationId, evaluationId as string), inArray(sessionTurns.status, ['queued', 'running'])))
    .limit(1)
  if (existingTurn) return { action: 'evaluation', evaluationId, turnId: existingTurn.id }

  const session = await ensureMainSession(ctx, project)
  const turn = await createTurn(ctx, {
    session,
    kind: 'eval',
    evaluationId,
    input: { evaluationId },
  })
  await ctx.queue.notify(turn.id)
  await audit(ctx, { projectId: project.id, action: 'evaluation.queued', target: `evaluation:${evaluationId}`, metadata: { triggerId } })
  return { action: 'evaluation', evaluationId, turnId: turn.id }
}

export async function createInput(
  ctx: DualContext,
  project: ProjectRow,
  ticket: TicketRow,
  triggerId: string | null,
  text: string,
  isPerson: boolean,
  source: 'trigger' | 'person' | 'note' | 'policy' | 'approval' | 'system' = isPerson ? 'person' : 'trigger',
): Promise<string> {
  const id = newId()
  await ctx.db.insert(ticketInputs).values({
    id,
    projectId: project.id,
    ticketId: ticket.id,
    triggerId: triggerId ?? null,
    source,
    text: text.slice(0, 20_000),
    isPerson,
    createdAt: ctx.now(),
  })

  const ended = ticket.stage === 'done' || ticket.stage === 'cancelled' || ticket.status === 'done' || ticket.status === 'cancelled'
  if (ended) {
    const [mandate] = await ctx.db.select().from(mandates).where(eq(mandates.ticketId, ticket.id))
    if (!mandate || mandate.revokedAt) return id
    await ctx.db
      .update(tickets)
      .set({ status: 'running', stage: 'queued', endedAt: null, endedReason: null, closedAt: null, updatedAt: ctx.now() })
      .where(eq(tickets.id, ticket.id))
    await queueExecutorTurn(ctx, { ...ticket, status: 'running', stage: 'queued' }, 'resume')
    return id
  }

  if (ticket.stage === 'plan_review' || ticket.status === 'planned') return id

  const active = await activeExecutorTurn(ctx, ticket.id)
  if (!active) {
    await queueExecutorTurn(ctx, ticket, 'input')
  }
  return id
}

export async function queueExecutorTurn(ctx: DualContext, ticket: TicketRow, reason: string): Promise<string | null> {
  if (ticket.stage === 'done' || ticket.stage === 'cancelled' || ticket.status === 'done' || ticket.status === 'cancelled') return null
  const active = await activeExecutorTurn(ctx, ticket.id)
  if (active) return active.id
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, ticket.projectId))
  if (!project || project.status !== 'active') return null
  const policy = policyOf(project)
  if (policy.dailyTokenBudget > 0) {
    const used = await tokensUsedToday(ctx, project.id)
    if (used >= policy.dailyTokenBudget) {
      await audit(ctx, {
        projectId: project.id,
        action: 'turn.budget_exhausted',
        target: `ticket:${ticket.id}`,
        metadata: { used, budget: policy.dailyTokenBudget },
      })
      return null
    }
  }
  const session = await ensureExecutorSession(ctx, project, ticket.id)
  const assignmentId = newId()
  try {
    await ctx.db.insert(assignments).values({
      id: assignmentId,
      projectId: project.id,
      ticketId: ticket.id,
      sessionId: session.id,
      status: 'pending',
      createdAt: ctx.now(),
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const activeAssignment = await activeExecutorTurn(ctx, ticket.id)
    return activeAssignment?.id ?? null
  }
  const turn = await createTurn(ctx, {
    session,
    kind: 'execute',
    ticketId: ticket.id,
    assignmentId,
    input: { ticketId: ticket.id, assignmentId, reason },
  })
  const [current] = await ctx.db.select().from(tickets).where(eq(tickets.id, ticket.id))
  if (current && current.status !== 'planned' && current.stage !== 'plan_review') {
    await ctx.db
      .update(tickets)
      .set({ status: 'triaged', stage: 'queued', updatedAt: ctx.now() })
      .where(eq(tickets.id, ticket.id))
  }
  await ctx.queue.notify(turn.id)
  await audit(ctx, { projectId: ticket.projectId, action: 'turn.queued', target: `turn:${turn.id}`, metadata: { ticketId: ticket.id, reason } })
  return turn.id
}

export interface CreateTicketInput {
  project: ProjectRow
  channel: ChannelRow | null
  trigger: {
    id: string
    threadKey: string | null
    text: string
    actorUserId: string | null
    actorName: string | null
  } | null
  actor: { id: string; name: string } | null
  title: string
  body: string
  scope: string
  strength: 'explicit' | 'inferred'
  priority?: 'low' | 'normal' | 'high' | 'urgent'
}

export async function createAcceptedTicket(ctx: DualContext, input: CreateTicketInput): Promise<TicketRow> {
  const version = policyVersion(policyOf(input.project))
  const ticketId = newId()
  const [ticket] = await ctx.db
    .insert(tickets)
    .values({
      id: ticketId,
      projectId: input.project.id,
      channelId: input.channel?.id ?? null,
      threadKey: input.trigger?.threadKey ?? null,
      requesterId: input.actor?.id ?? input.trigger?.actorUserId ?? null,
      requesterName: input.actor?.name ?? input.trigger?.actorName ?? null,
      title: input.title.slice(0, 200),
      body: input.body.slice(0, 20_000),
      status: 'triaged',
      stage: 'queued',
      priority: input.priority ?? 'normal',
      policyVersion: version,
      originTriggerId: input.trigger?.id ?? null,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    })
    .returning()
  if (!ticket) throw new Error('failed to create ticket')

  await ctx.db.insert(mandates).values({
    id: newId(),
    projectId: input.project.id,
    ticketId,
    policyVersion: version,
    strength: input.strength,
    scope: input.scope.slice(0, 4000),
    matchedRules: [],
    basis: {
      provider: input.channel?.provider ?? null,
      threadKey: input.trigger?.threadKey ?? null,
      explicit: input.strength === 'explicit',
    },
    requesterTriggerId: input.trigger?.id ?? null,
    requesterUserId: input.actor?.id ?? input.trigger?.actorUserId ?? null,
    createdAt: ctx.now(),
  })

  if (input.trigger && input.channel) {
    await ctx.db
      .insert(ticketSubscriptions)
      .values({
        id: newId(),
        projectId: input.project.id,
        ticketId,
        provider: input.channel.provider,
        channelId: input.channel.id,
        threadKey: input.trigger.threadKey ?? input.trigger.id,
        kind: 'own',
        createdAt: ctx.now(),
      })
      .onConflictDoNothing()
  }

  await audit(ctx, {
    projectId: input.project.id,
    actorId: input.actor?.id ?? null,
    actorLabel: input.actor?.name ?? input.trigger?.actorName ?? null,
    action: 'ticket.created',
    target: `ticket:${ticketId}`,
    metadata: { title: ticket.title, triggerId: input.trigger?.id ?? null, strength: input.strength },
  })
  return ticket
}

export interface ExecutorDelivery {
  branch?: string | null
  prUrl?: string | null
  workspace?: string
}

export async function applyMainDecision(ctx: DualContext, turnId: string, output: unknown): Promise<void> {
  const turn = (await ctx.db.select().from(sessionTurns).where(eq(sessionTurns.id, turnId)))[0]
  if (!turn?.evaluationId) throw new Error('main turn has no evaluation')
  const [evaluation] = await ctx.db.select().from(evaluations).where(eq(evaluations.id, turn.evaluationId))
  if (!evaluation) throw new Error('evaluation not found')
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, evaluation.projectId))
  const [channel] = evaluation.channelId
    ? await ctx.db.select().from(channels).where(eq(channels.id, evaluation.channelId))
    : [null]
  if (!project) throw new Error('project not found')

  const parsed = MAIN_DECISION_OUTPUT.safeParse(output)
  if (!parsed.success) throw new Error(`invalid Main Session decision: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`)

  const session = (await ctx.db.select().from(agentSessions).where(eq(agentSessions.id, turn.sessionId)))[0]
  const batchIds = new Set(evaluation.triggerIds)
  const decided = new Set<string>()
  for (const decision of parsed.data.decisions) {
    if (!batchIds.has(decision.triggerId)) {
      await audit(ctx, { projectId: project.id, action: 'decision.refused', target: `evaluation:${evaluation.id}`, metadata: { reason: 'trigger not in batch', triggerId: decision.triggerId } })
      continue
    }
    const [trigger] = await ctx.db.select().from(triggers).where(eq(triggers.id, decision.triggerId))
    if (!trigger) continue
    decided.add(trigger.id)

    if (decision.action === 'accept' && decision.ticket) {
      if (channel) {
        const existing = await ctx.db
          .select({ id: tickets.id })
          .from(tickets)
          .where(and(eq(tickets.projectId, project.id), eq(tickets.originTriggerId, trigger.id)))
          .limit(1)
        if (existing.length > 0) continue
      }
      const ticket = await createAcceptedTicket(ctx, {
        project,
        channel,
        trigger: {
          id: trigger.id,
          threadKey: trigger.threadKey,
          text: trigger.text,
          actorUserId: trigger.actorUserId,
          actorName: trigger.actorName,
        },
        actor: trigger.actorUserId ? { id: trigger.actorUserId, name: trigger.actorName ?? '成员' } : null,
        title: decision.ticket.title,
        body: decision.ticket.body ?? trigger.text,
        scope: decision.ticket.scope,
        strength: decision.ticket.strength,
      })
      await queueExecutorTurn(ctx, ticket, 'accepted')
      if (channel) {
        await replyToChannel(ctx, project, channel, trigger.id, decision.reply ?? DEFAULT_REPLY, trigger.replyTo)
      }
      continue
    }

    if (decision.action === 'ignore') {
      await audit(ctx, {
        projectId: project.id,
        action: 'decision.ignored',
        target: `trigger:${trigger.id}`,
        metadata: { reason: decision.reason ?? null },
      })
      continue
    }

    if (decision.action === 'attach' && decision.ticketId) {
      const [target] = await ctx.db.select().from(tickets).where(and(eq(tickets.id, decision.ticketId), eq(tickets.projectId, project.id)))
      if (!target || !channel) continue
      await ctx.db
        .insert(ticketSubscriptions)
        .values({
          id: newId(),
          projectId: project.id,
          ticketId: target.id,
          provider: channel.provider,
          channelId: channel.id,
          threadKey: trigger.threadKey ?? trigger.id,
          kind: 'own',
          createdAt: ctx.now(),
        })
        .onConflictDoNothing()
      await createInput(ctx, project, target, trigger.id, trigger.text, true)
      continue
    }

    if (decision.action === 'stop' && decision.ticketId) {
      await stopTicket(ctx, project.id, decision.ticketId, { id: trigger.actorUserId, name: trigger.actorName ?? 'Main Session' }, decision.reason ?? 'stopped by Main Session')
    }
  }

  await ctx.db
    .update(evaluations)
    .set({ status: 'decided', decision: parsed.data, endedAt: ctx.now() })
    .where(eq(evaluations.id, evaluation.id))
  if (session) {
    await appendSessionMessage(ctx, session, 'assistant', JSON.stringify(parsed.data.decisions), turn.id, { evaluationId: evaluation.id })
  }

  // A protocol-compliant Main Session decides every Trigger. If it skipped
  // some, retry them once as a fresh Eval instead of silently dropping them.
  const leftover = evaluation.triggerIds.filter((id) => !decided.has(id))
  if (leftover.length > 0) {
    await audit(ctx, {
      projectId: project.id,
      action: 'evaluation.unhandled',
      target: `evaluation:${evaluation.id}`,
      metadata: { triggerIds: leftover, attempts: evaluation.attempts },
    })
    if (evaluation.attempts < 2) {
      const retryId = newId()
      await ctx.db.insert(evaluations).values({
        id: retryId,
        projectId: project.id,
        channelId: evaluation.channelId,
        threadKey: evaluation.threadKey,
        policyVersion: evaluation.policyVersion,
        status: 'queued',
        triggerIds: leftover,
        createdAt: ctx.now(),
      })
      await ctx.db.update(triggers).set({ evaluationId: retryId }).where(inArray(triggers.id, leftover))
      const mainSession = await ensureMainSession(ctx, project)
      const retryTurn = await createTurn(ctx, { session: mainSession, kind: 'eval', evaluationId: retryId, input: { evaluationId: retryId } })
      await ctx.queue.notify(retryTurn.id)
    } else {
      await ctx.db
        .update(triggers)
        .set({ evaluationId: null })
        .where(inArray(triggers.id, leftover))
    }
  }
}

export async function applyExecutorReport(
  ctx: DualContext,
  turnId: string,
  delivery: ExecutorDelivery,
  output: unknown,
): Promise<void> {
  const turn = (await ctx.db.select().from(sessionTurns).where(eq(sessionTurns.id, turnId)))[0]
  if (!turn?.ticketId) throw new Error('executor turn has no ticket')
  const [ticket] = await ctx.db.select().from(tickets).where(eq(tickets.id, turn.ticketId))
  const [project] = ticket ? await ctx.db.select().from(projects).where(eq(projects.id, ticket.projectId)) : [undefined]
  if (!ticket || !project) throw new Error('ticket not found')
  const parsed = EXECUTOR_REPORT_OUTPUT.safeParse(output)
  if (!parsed.success) throw new Error(`invalid Executor report: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`)
  const report = parsed.data
  const policy = policyOf(project)
  const planGate =
    policy.planApproval === 'required' &&
    !ticket.planApprovedAt &&
    Boolean(report.plan) &&
    report.status !== 'failed' &&
    report.status !== 'blocked' &&
    report.status !== 'dropped'

  const stage: TicketStage = planGate ? 'plan_review' : report.attention ? 'answer' : report.status === 'ready' ? 'review' : report.status === 'blocked' ? 'blocked' : report.status === 'failed' ? 'failed' : report.status === 'dropped' ? 'cancelled' : report.status === 'waiting' ? 'idle' : 'working'
  const status = statusFromStage(stage)
  const reportId = newId()
  await ctx.db.insert(reports).values({
    id: reportId,
    projectId: project.id,
    ticketId: ticket.id,
    assignmentId: turn.assignmentId,
    turnId: turn.id,
    status: planGate ? 'progress' : report.status,
    summary: report.summary.slice(0, 6000),
    plan: report.plan?.slice(0, 20_000) ?? ticket.plan,
    attentionQuestion: report.attention?.question ?? null,
    branch: delivery.branch ?? report.branch ?? ticket.branch,
    prUrl: delivery.prUrl ?? ticket.prUrl,
    tokens: report.tokens ?? turn.tokens,
    cost: report.cost ?? turn.cost,
    raw: report,
    createdAt: ctx.now(),
  })

  await ctx.db
    .update(tickets)
    .set({
      status,
      stage,
      plan: report.plan?.slice(0, 20_000) ?? ticket.plan,
      branch: delivery.branch ?? report.branch ?? ticket.branch,
      prUrl: delivery.prUrl ?? ticket.prUrl,
      lastReportId: reportId,
      endedAt: stage === 'cancelled' ? ctx.now() : null,
      closedAt: stage === 'cancelled' ? ctx.now() : null,
      updatedAt: ctx.now(),
    })
    .where(eq(tickets.id, ticket.id))

  const updated = { ...ticket, status, stage, plan: report.plan ?? ticket.plan, prUrl: delivery.prUrl ?? ticket.prUrl } as TicketRow
  if (planGate) {
    await notifications.approvalNeeded(ctx, updated, report.plan ?? report.summary)
  } else if (report.attention) {
    await notifications.message(
      ctx,
      project,
      ticket.channelId ?? (await firstChannelId(ctx, project.id)) ?? '',
      `❓ ${ticketTitle(ticket.title)} 需要人回答：${report.attention.question}`,
      undefined,
      `attention:${ticket.id}:${turn.id}`,
    )
  } else if (report.status === 'ready') {
    if (updated.prUrl) await notifications.prOpened(ctx, updated, updated.prUrl, report.summary)
    else await notifications.completedWithoutPr(ctx, updated, report.summary)
  } else if (report.status === 'blocked' || report.status === 'failed') {
    await notifications.failed(ctx, updated, report.summary)
  }

  const pendingInputs = await ctx.db
    .select({ id: ticketInputs.id })
    .from(ticketInputs)
    .where(and(eq(ticketInputs.ticketId, ticket.id), sql`${ticketInputs.deliveredAt} is null`))
  if (pendingInputs.length > 0 && !['plan_review', 'blocked', 'failed', 'cancelled', 'done'].includes(stage)) {
    await queueExecutorTurn(ctx, updated, 'pending inputs')
  }
  await audit(ctx, {
    projectId: project.id,
    action: 'report.recorded',
    target: `ticket:${ticket.id}`,
    metadata: { status: report.status, stage, prUrl: updated.prUrl ?? null },
  })
}

async function firstChannelId(ctx: Deps, projectId: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.projectId, projectId), eq(channels.status, 'active')))
    .limit(1)
  return row?.id ?? null
}

export async function buildMainPacket(ctx: Deps, turnId: string): Promise<MainTurnPacket> {
  const turn = (await ctx.db.select().from(sessionTurns).where(eq(sessionTurns.id, turnId)))[0]
  if (!turn?.evaluationId) throw new Error('main turn has no evaluation')
  const [evaluation] = await ctx.db.select().from(evaluations).where(eq(evaluations.id, turn.evaluationId))
  if (!evaluation) throw new Error('evaluation not found')
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, evaluation.projectId))
  if (!project) throw new Error('project not found')
  const [channel] = evaluation.channelId ? await ctx.db.select().from(channels).where(eq(channels.id, evaluation.channelId)) : [null]
  const triggerRows = evaluation.triggerIds.length
    ? await ctx.db.select().from(triggers).where(inArray(triggers.id, evaluation.triggerIds)).orderBy(triggers.createdAt)
    : []
  const ticketRows = await ctx.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, project.id), inArray(tickets.status, ['new', 'triaged', 'planned', 'running', 'waiting_review'])))
    .orderBy(desc(tickets.updatedAt))
    .limit(20)
  const session = (await ctx.db.select().from(agentSessions).where(eq(agentSessions.id, turn.sessionId)))[0]
  return {
    role: 'main',
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      policyVersion: policyVersion(policyOf(project)),
      policy: policyOf(project) as unknown as Record<string, unknown>,
    },
    channel: channel ? { id: channel.id, provider: channel.provider, name: channel.name, chatId: channel.externalChatId } : null,
    thread: {
      key: evaluation.threadKey,
      triggers: triggerRows.map((row) => ({
        id: row.id,
        kind: row.kind,
        text: row.text,
        actorName: row.actorName,
        actorUserId: row.actorUserId,
        isBot: row.isBot,
        mentionedBot: row.mentionedBot,
        threadKey: row.threadKey,
        createdAt: row.createdAt.toISOString(),
      })),
    },
    tickets: ticketRows.map((row) => ({
      id: row.id,
      title: row.title,
      stage: row.stage,
      status: row.status,
      summary: null,
      plan: row.plan,
      prUrl: row.prUrl,
      updatedAt: row.updatedAt.toISOString(),
    })),
    transcript: session ? await recentTranscript(ctx, session.id) : [],
  }
}

export async function buildExecutorPacket(ctx: Deps, turnId: string, workspaceReady: boolean): Promise<ExecutorTurnPacket> {
  const turn = (await ctx.db.select().from(sessionTurns).where(eq(sessionTurns.id, turnId)))[0]
  if (!turn?.ticketId) throw new Error('executor turn has no ticket')
  const [ticket] = await ctx.db.select().from(tickets).where(eq(tickets.id, turn.ticketId))
  const [project] = ticket ? await ctx.db.select().from(projects).where(eq(projects.id, ticket.projectId)) : [undefined]
  if (!ticket || !project) throw new Error('ticket not found')
  const [mandate] = await ctx.db.select().from(mandates).where(eq(mandates.ticketId, ticket.id))
  const inputs = await ctx.db
    .select()
    .from(ticketInputs)
    .where(and(eq(ticketInputs.ticketId, ticket.id), sql`${ticketInputs.deliveredAt} is null`))
    .orderBy(ticketInputs.createdAt)
  const [latestReport] = await ctx.db.select().from(reports).where(eq(reports.ticketId, ticket.id)).orderBy(desc(reports.createdAt)).limit(1)
  const session = (await ctx.db.select().from(agentSessions).where(eq(agentSessions.id, turn.sessionId)))[0]
  return {
    role: 'executor',
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      policyVersion: mandate?.policyVersion ?? policyVersion(policyOf(project)),
      policy: policyOf(project) as unknown as Record<string, unknown>,
    },
    ticket: {
      id: ticket.id,
      title: ticket.title,
      body: ticket.body,
      plan: ticket.plan,
      planApproved: Boolean(ticket.planApprovedAt),
      branch: ticket.branch,
      prUrl: ticket.prUrl,
      requesterName: ticket.requesterName,
    },
    mandate: {
      scope: mandate?.scope ?? '完成工单需求',
      strength: mandate?.strength ?? 'explicit',
      policyVersion: mandate?.policyVersion ?? '',
      matchedRules: mandate?.matchedRules ?? [],
    },
    inputs: inputs.map((input) => ({
      id: input.id,
      source: input.source,
      text: input.text,
      isPerson: input.isPerson,
      createdAt: input.createdAt.toISOString(),
    })),
    latestReport: latestReport
      ? {
          status: latestReport.status,
          summary: latestReport.summary,
          plan: latestReport.plan,
          attention: latestReport.attentionQuestion,
        }
      : null,
    transcript: session ? await recentTranscript(ctx, session.id) : [],
    workspaceReady,
  }
}

export async function markInputsDelivered(ctx: Deps, ticketId: string, ids: string[], read = false): Promise<void> {
  if (ids.length === 0) return
  await ctx.db
    .update(ticketInputs)
    .set({ deliveredAt: ctx.now(), ...(read ? { readAt: ctx.now() } : {}) })
    .where(and(eq(ticketInputs.ticketId, ticketId), inArray(ticketInputs.id, ids)))
}

// ---------------------------------------------------------------------------
// Commands and human actions
// ---------------------------------------------------------------------------

export async function handleCommand(
  ctx: DualContext,
  input: {
    project: ProjectRow
    channel: ChannelRow
    triggerId: string
    threadKey: string
    command: ParsedCommand
    userId: string | null
    userName: string | null
    role: MemberRole | null
    replyTo: string | null
  },
): Promise<ReceiveResult> {
  const { project, channel, command, role, triggerId } = input
  if (!role) {
    await replyToChannel(ctx, project, channel, triggerId, '你还不是项目成员，无法使用命令。', input.replyTo)
    return { action: 'command', reason: 'not_member' }
  }
  if (command.name === 'unknown') {
    await replyToChannel(ctx, project, channel, triggerId, `未知命令。\n${HELP_TEXT}`, input.replyTo)
    return { action: 'command', reason: 'unknown_command' }
  }
  if (command.name === 'help') {
    await replyToChannel(ctx, project, channel, triggerId, HELP_TEXT, input.replyTo)
    return { action: 'command', reason: 'help' }
  }
  if (command.name === 'bind') {
    await replyToChannel(ctx, project, channel, triggerId, '当前群已绑定项目；如需更换请在控制台解绑。', input.replyTo)
    return { action: 'command', reason: 'already_bound' }
  }
  const needed = commandNeedsRole[command.name]
  if (!atLeast(role, needed)) {
    await replyToChannel(ctx, project, channel, triggerId, `你的角色（${role}）不能执行 /${command.name}。`, input.replyTo)
    return { action: 'command', reason: 'insufficient_role' }
  }
  if (project.status === 'paused' && command.name !== 'status' && command.name !== 'cancel') {
    await replyToChannel(ctx, project, channel, triggerId, '项目已暂停，暂不执行该命令。', input.replyTo)
    return { action: 'command', reason: 'project_paused' }
  }

  const ticket = await resolveTicket(ctx, project.id, channel, input.threadKey, command.arg)
  if (command.name === 'status') {
    if (!ticket) {
      await replyToChannel(ctx, project, channel, triggerId, '当前会话没有可查询的工单。', input.replyTo)
      return { action: 'command', reason: 'no_ticket' }
    }
    await replyToChannel(
      ctx,
      project,
      channel,
      triggerId,
      [`📋 #${shortId(ticket.id)} ${ticket.title}`, `Stage：${ticket.stage ?? ticket.status}`, ticket.plan ? `计划：${ticket.plan.slice(0, 300)}` : '', ticket.prUrl ? `PR：${ticket.prUrl}` : '']
        .filter(Boolean)
        .join('\n'),
      input.replyTo,
    )
    return { action: 'command', ticketId: ticket.id, reason: 'status' }
  }
  if (!ticket) {
    await replyToChannel(ctx, project, channel, triggerId, `没有找到可操作的工单。用法：/${command.name} #工单号`, input.replyTo)
    return { action: 'command', reason: 'no_ticket' }
  }
  const actor = { id: input.userId ?? '', name: input.userName ?? 'Member' }
  if (command.name === 'cancel') {
    await stopTicket(ctx, project.id, ticket.id, actor, 'command')
    await replyToChannel(ctx, project, channel, triggerId, `🛑 已停止 #${shortId(ticket.id)}。`, input.replyTo)
    return { action: 'command', ticketId: ticket.id, reason: 'cancel' }
  }
  if (command.name === 'retry') {
    await retryTicket(ctx, project.id, ticket.id, actor)
    await replyToChannel(ctx, project, channel, triggerId, `🔁 已重新排队 #${shortId(ticket.id)}。`, input.replyTo)
    return { action: 'command', ticketId: ticket.id, reason: 'retry' }
  }
  if (command.name === 'approve') {
    await approvePlan(ctx, project.id, ticket.id, actor)
    await replyToChannel(ctx, project, channel, triggerId, `✅ 已批准计划，Executor 开始执行。`, input.replyTo)
    return { action: 'command', ticketId: ticket.id, reason: 'approve' }
  }
  return { action: 'command', reason: 'handled' }
}

export async function approvePlan(ctx: DualContext, projectId: string, ticketId: string, actor: { id: string; name: string }, comment?: string): Promise<TicketRow> {
  const [ticket] = await ctx.db.select().from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.projectId, projectId)))
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId))
  if (!ticket || !project) throw notFound('工单不存在')
  if (ticket.stage !== 'plan_review' && ticket.status !== 'planned') throw conflict('工单没有等待审批的计划')
  await ctx.db.insert(approvals).values({
    id: newId(),
    projectId,
    ticketId,
    kind: 'plan',
    actorId: actor.id || null,
    decision: 'approved',
    comment: comment ?? null,
    createdAt: ctx.now(),
  })
  const updated = (
    await ctx.db
      .update(tickets)
      .set({ planApprovedAt: ctx.now(), status: 'running', stage: 'queued', updatedAt: ctx.now() })
      .where(eq(tickets.id, ticketId))
      .returning()
  )[0]
  if (!updated) throw new Error('ticket not found')
  await createInput(ctx, project, updated, null, '计划已批准，开始执行。', false, 'approval')
  await queueExecutorTurn(ctx, updated, 'plan approved')
  await audit(ctx, { projectId, actorId: actor.id || null, actorLabel: actor.name, action: 'ticket.plan_approved', target: `ticket:${ticketId}` })
  return updated
}

export async function stopTicket(
  ctx: DualContext,
  projectId: string,
  ticketId: string,
  actor: { id: string | null; name: string },
  reason: string,
): Promise<TicketRow> {
  const [ticket] = await ctx.db.select().from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.projectId, projectId)))
  if (!ticket) throw new Error('ticket not found')
  await ctx.db.update(mandates).set({ revokedAt: ctx.now() }).where(eq(mandates.ticketId, ticketId))
  const [updated] = await ctx.db
    .update(tickets)
    .set({ status: 'cancelled', stage: 'cancelled', endedAt: ctx.now(), endedReason: reason, closedAt: ctx.now(), updatedAt: ctx.now() })
    .where(eq(tickets.id, ticketId))
    .returning()
  await cancelQueuedTurns(ctx, ticketId)
  await ctx.db
    .update(sessionTurns)
    .set({ cancelRequestedAt: ctx.now() })
    .where(and(eq(sessionTurns.ticketId, ticketId), eq(sessionTurns.status, 'running')))
  await audit(ctx, { projectId, actorId: actor.id, actorLabel: actor.name, action: 'ticket.stopped', target: `ticket:${ticketId}`, metadata: { reason } })
  if (updated) await notifications.cancelled(ctx, updated, actor.name)
  return updated ?? ticket
}

export async function retryTicket(ctx: DualContext, projectId: string, ticketId: string, actor: { id: string | null; name: string }): Promise<TicketRow> {
  const [ticket] = await ctx.db.select().from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.projectId, projectId)))
  if (!ticket) throw notFound('工单不存在')
  if (!['failed', 'blocked'].includes(ticket.stage ?? '')) throw conflict('只有失败或受阻的工单可以重试')
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId))
  if (!project) throw new Error('project not found')
  const [updated] = await ctx.db
    .update(tickets)
    .set({ status: 'running', stage: 'queued', endedAt: null, endedReason: null, closedAt: null, updatedAt: ctx.now() })
    .where(eq(tickets.id, ticketId))
    .returning()
  if (updated) await queueExecutorTurn(ctx, updated, 'retry')
  await audit(ctx, { projectId, actorId: actor.id, actorLabel: actor.name, action: 'ticket.retried', target: `ticket:${ticketId}` })
  return updated ?? ticket
}

export async function markMerged(ctx: DualContext, ticketId: string, prUrl?: string | null): Promise<TicketRow | null> {
  const [ticket] = await ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
  if (!ticket) return null
  const [updated] = await ctx.db
    .update(tickets)
    .set({
      status: 'done',
      stage: 'done',
      prUrl: prUrl ?? ticket.prUrl,
      endedAt: ctx.now(),
      closedAt: ctx.now(),
      endedReason: 'merged',
      updatedAt: ctx.now(),
    })
    .where(eq(tickets.id, ticketId))
    .returning()
  await cancelQueuedTurns(ctx, ticketId)
  await ctx.db
    .update(sessionTurns)
    .set({ cancelRequestedAt: ctx.now() })
    .where(and(eq(sessionTurns.ticketId, ticketId), eq(sessionTurns.status, 'running')))
  if (updated) await notifications.done(ctx, updated)
  await audit(ctx, { projectId: ticket.projectId, action: 'ticket.merged', target: `ticket:${ticketId}`, metadata: { prUrl: prUrl ?? null } })
  return updated ?? ticket
}

export async function markClosed(ctx: DualContext, ticketId: string, prUrl?: string | null): Promise<TicketRow | null> {
  const [ticket] = await ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
  if (!ticket) return null
  const [updated] = await ctx.db
    .update(tickets)
    .set({ status: 'cancelled', stage: 'cancelled', prUrl: prUrl ?? ticket.prUrl, endedAt: ctx.now(), closedAt: ctx.now(), endedReason: 'pr_closed', updatedAt: ctx.now() })
    .where(eq(tickets.id, ticketId))
    .returning()
  await cancelQueuedTurns(ctx, ticketId)
  await ctx.db
    .update(sessionTurns)
    .set({ cancelRequestedAt: ctx.now() })
    .where(and(eq(sessionTurns.ticketId, ticketId), eq(sessionTurns.status, 'running')))
  if (updated) await notifications.cancelled(ctx, updated, 'GitHub')
  await audit(ctx, { projectId: ticket.projectId, action: 'ticket.pr_closed', target: `ticket:${ticketId}` })
  return updated ?? ticket
}

export async function policyChanged(ctx: Deps, project: ProjectRow, previousVersion: string): Promise<number> {
  const nextVersion = policyVersion(policyOf(project))
  if (nextVersion === previousVersion) return 0
  const live = await ctx.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, project.id), inArray(tickets.status, ['new', 'triaged', 'planned', 'running', 'waiting_review'])))
  for (const ticket of live) {
    if (ticket.policyVersion === nextVersion) continue
    await ctx.db.insert(ticketInputs).values({
      id: newId(),
      projectId: project.id,
      ticketId: ticket.id,
      source: 'policy',
      text: `项目 Policy 已从 ${previousVersion} 更新为 ${nextVersion}；Mandate 仍然有效，请按新规则继续。`,
      isPerson: false,
      createdAt: ctx.now(),
    })
    await audit(ctx, { projectId: project.id, action: 'policy.changed', target: `ticket:${ticket.id}`, metadata: { from: previousVersion, to: nextVersion } })
  }
  return live.length
}

export async function reapStaleTurns(ctx: DualContext): Promise<number> {
  const stale = await findStaleTurns(ctx, ctx.config.RUN_LEASE_SECONDS)
  for (const turn of stale) {
    await finishTurn(ctx, turn, { status: 'timeout', error: 'worker heartbeat timed out' })
    if (turn.kind === 'eval' && turn.evaluationId) {
      await ctx.db
        .update(evaluations)
        .set({ status: 'unavailable', reason: 'worker heartbeat timed out', endedAt: ctx.now() })
        .where(eq(evaluations.id, turn.evaluationId))
    }
    if (turn.kind === 'execute' && turn.ticketId) {
      const [ticket] = await ctx.db.select().from(tickets).where(eq(tickets.id, turn.ticketId))
      if (ticket && !['done', 'cancelled'].includes(ticket.stage ?? '')) {
        const updated = (
          await ctx.db
            .update(tickets)
            .set({ status: 'failed', stage: 'failed', updatedAt: ctx.now() })
            .where(eq(tickets.id, ticket.id))
            .returning()
        )[0]
        if (updated) await notifications.failed(ctx, updated, 'Worker 心跳超时')
      }
    }
    await audit(ctx, { projectId: turn.projectId, action: 'turn.reaped', target: `turn:${turn.id}` })
  }
  return stale.length
}

export async function activeTurnCount(ctx: Deps, projectId: string): Promise<number> {
  const rows = await ctx.db
    .select({ value: sql<number>`count(*)::int` })
    .from(sessionTurns)
    .where(and(eq(sessionTurns.projectId, projectId), eq(sessionTurns.status, 'running')))
  return Number(rows[0]?.value ?? 0)
}

export async function sessionForProject(ctx: Deps, projectId: string) {
  const [session] = await ctx.db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.projectId, projectId), eq(agentSessions.role, 'main')))
  return session ?? null
}

export async function sessionForTicket(ctx: Deps, ticketId: string) {
  const [session] = await ctx.db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.ticketId, ticketId), eq(agentSessions.role, 'executor')))
  return session ?? null
}

export { userForTrigger, latestTicketForThread, latestOpenTicket }
