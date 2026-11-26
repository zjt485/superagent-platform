import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, asc, count, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import {
  actionApprovals,
  agentSessions,
  auditLogs,
  bots,
  mandates,
  outboxEvents,
  projects,
  reports,
  rooms,
  sessionMessages,
  sessionTurns,
  tickets,
  turnEvents,
  usage,
  type BotRow,
  type ProjectRow,
  type TicketInputRow,
  type TicketRow,
  type TurnCheckpoint,
  type TurnRow,
} from '../../db/schema.js'
import { buildExecutorPrompt } from '../agent/prompts.js'
import type { ExecutorBotPersona, ExecutorTurnPacket, TurnResumeInput } from '../agent/types.js'
import { newId } from '../../domain/ids.js'
import { parsePolicy } from '../../domain/policy.js'
import { formatBotSignature } from '../../services/bots.js'
import { defaultEventBus, type ProjectEventBus } from '../../services/events.js'
import { appendRoomMessage } from '../../services/rooms.js'
import { dayKey } from '../../services/usage.js'
import { receiveCoreTrigger } from '../intake.js'
import { nextStage } from '../domain/stage.js'
import type { Report, TicketStage } from '../domain/types.js'
import { listUndeliveredInputs, markInputsDelivered } from '../store/inputs.js'
import { setTicketDelivery, setTicketStage, setTicketWorktree } from '../store/tickets.js'
import { finishTurn } from '../store/turns.js'
import { branchName } from '../domain/ids.js'
import type { DeliveryProvider } from './delivery.js'
import type { Executor } from './executor.js'
import type { WorkspaceProvider } from './workspace-provider.js'

export interface DispatcherOptions {
  db: Database
  executor: Executor
  now: () => Date
  worktreeRoot?: string
  transcriptRoot?: string
  timeoutMs?: number
  heartbeatMs?: number
  env?: Record<string, string>
  workspace?: WorkspaceProvider
  delivery?: DeliveryProvider
  events?: ProjectEventBus
}

async function claimNextTurn(db: Database, at: Date): Promise<TurnRow | undefined> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(sessionTurns)
      .where(
        and(
          eq(sessionTurns.status, 'queued'),
          inArray(sessionTurns.kind, ['execute', 'resume']),
          isNotNull(sessionTurns.ticketId),
        ),
      )
      .orderBy(asc(sessionTurns.createdAt))
      .limit(20)
      .for('update', { skipLocked: true })

    const projectCache = new Map<string, ProjectRow | null>()
    const runningByProject = new Map<string, number>()

    for (const candidate of candidates) {
      if (candidate.ticketId === null) continue
      const [runningTicketTurn] = await tx
        .select({ id: sessionTurns.id })
        .from(sessionTurns)
        .where(and(eq(sessionTurns.ticketId, candidate.ticketId), eq(sessionTurns.status, 'running')))
        .limit(1)
      if (runningTicketTurn !== undefined) continue

      let project = projectCache.get(candidate.projectId)
      if (project === undefined) {
        const [row] = await tx.select().from(projects).where(eq(projects.id, candidate.projectId))
        project = row ?? null
        projectCache.set(candidate.projectId, project)
      }
      if (project !== null) {
        if (project.status !== 'active') continue
        const policy = parsePolicy(project.policyJson)
        let runningCount = runningByProject.get(project.id)
        if (runningCount === undefined) {
          const [cnt] = await tx
            .select({ value: count() })
            .from(sessionTurns)
            .where(
              and(
                eq(sessionTurns.projectId, project.id),
                inArray(sessionTurns.kind, ['execute', 'resume']),
                eq(sessionTurns.status, 'running'),
              ),
            )
          runningCount = Number(cnt?.value ?? 0)
          runningByProject.set(project.id, runningCount)
        }
        if (runningCount >= policy.maxConcurrentRuns) continue
      }

      const [claimed] = await tx
        .update(sessionTurns)
        .set({ status: 'running', startedAt: at, heartbeatAt: at })
        .where(eq(sessionTurns.id, candidate.id))
        .returning()
      if (claimed !== undefined) {
        await tx
          .update(agentSessions)
          .set({ status: 'running', updatedAt: at })
          .where(eq(agentSessions.id, claimed.sessionId))
        return claimed
      }
    }
    return undefined
  })
}

function stageForReport(
  current: TicketStage,
  report: Report,
  options: { planApprovalRequired: boolean; planApproved: boolean; codeChanged: boolean },
): TicketStage {
  if (
    options.planApprovalRequired &&
    !options.planApproved &&
    report.plan !== undefined &&
    report.plan.length > 0 &&
    (report.status === 'progress' || report.status === 'waiting')
  ) {
    try {
      return nextStage(current, { type: 'waiting', plan: true })
    } catch {
      return 'plan_review'
    }
  }
  try {
    switch (report.status) {
      case 'progress':
        return nextStage(current, { type: 'progress' })
      case 'waiting':
        return nextStage(current, { type: 'waiting', plan: report.plan !== undefined })
      case 'ready':
        return nextStage(current, { type: 'ready', codeChanged: options.codeChanged })
      case 'blocked':
        return nextStage(current, { type: 'blocked' })
      case 'failed':
        return nextStage(current, { type: 'failed' })
      case 'dropped':
        return nextStage(current, { type: 'stop' })
    }
  } catch {
    return current
  }
}

async function buildPacket(
  db: Database,
  project: ProjectRow,
  ticket: TicketRow,
  turn: TurnRow,
  inputs: TicketInputRow[],
  bot: BotRow | null,
): Promise<{ packet: ExecutorTurnPacket; prompt: string }> {
  const policyVersion = ticket.policyVersion ?? 'v1'
  const [mandate] = await db.select().from(mandates).where(eq(mandates.ticketId, ticket.id))
  const [latest] = await db
    .select()
    .from(reports)
    .where(eq(reports.ticketId, ticket.id))
    .orderBy(desc(reports.createdAt))
    .limit(1)
  const recent = await db
    .select()
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, turn.sessionId))
    .orderBy(desc(sessionMessages.createdAt))
    .limit(12)

  let botPersona: ExecutorBotPersona | null = null
  if (bot !== null) {
    const projectBots = await db
      .select({ id: bots.id, slug: bots.slug, name: bots.name, roleTitle: bots.roleTitle })
      .from(bots)
      .where(and(eq(bots.projectId, project.id), eq(bots.status, 'active')))
    botPersona = {
      id: bot.id,
      slug: bot.slug,
      name: bot.name,
      roleTitle: bot.roleTitle,
      systemPrompt: bot.systemPrompt,
      teammates: projectBots
        .filter((candidate) => candidate.id !== bot.id)
        .map((candidate) => ({ slug: candidate.slug, name: candidate.name, roleTitle: candidate.roleTitle })),
    }
  }

  const packet: ExecutorTurnPacket = {
    role: 'executor',
    ...(botPersona ? { bot: botPersona } : {}),
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      policyVersion,
      policy: project.policyJson as unknown as Record<string, unknown>,
    },
    ticket: {
      id: ticket.id,
      title: ticket.title,
      body: ticket.body,
      plan: ticket.plan,
      planApproved: ticket.planApprovedAt !== null,
      branch: ticket.branch,
      prUrl: ticket.prUrl,
      requesterName: ticket.requesterName,
    },
    mandate: {
      scope: mandate?.scope ?? ticket.title,
      strength: mandate?.strength ?? 'explicit',
      policyVersion: mandate?.policyVersion ?? policyVersion,
      matchedRules: mandate?.matchedRules ?? [],
    },
    inputs: inputs.map((input) => ({
      id: input.id,
      source: input.source,
      text: input.text,
      isPerson: input.isPerson,
      createdAt: input.createdAt.toISOString(),
    })),
    latestReport:
      latest === undefined
        ? null
        : {
            status: latest.status,
            summary: latest.summary,
            plan: latest.plan,
            attention: latest.attentionQuestion,
          },
    transcript: recent.reverse().map((message) => ({ role: message.role, content: message.content })),
    workspaceReady: ticket.worktreePath !== null,
  }
  return { packet, prompt: buildExecutorPrompt(packet) }
}

/** Claim one queued executor turn, run it and persist its report. */
export async function dispatchOnce(options: DispatcherOptions): Promise<boolean> {
  const at = options.now()
  const turn = await claimNextTurn(options.db, at)
  if (turn === undefined || turn.ticketId === null) return false

  const [ticket] = await options.db.select().from(tickets).where(eq(tickets.id, turn.ticketId))
  if (ticket === undefined) {
    await finishTurn(options.db, turn.id, { status: 'failed', error: 'ticket missing', at })
    await options.db.update(agentSessions).set({ status: 'idle', updatedAt: at }).where(eq(agentSessions.id, turn.sessionId))
    return true
  }
  const [project] = await options.db.select().from(projects).where(eq(projects.id, ticket.projectId))
  if (project === undefined) {
    await finishTurn(options.db, turn.id, { status: 'failed', error: 'project missing', at })
    await options.db.update(agentSessions).set({ status: 'idle', updatedAt: at }).where(eq(agentSessions.id, turn.sessionId))
    return true
  }

  const policy = parsePolicy(project.policyJson)
  if (policy.dailyTokenBudget > 0) {
    const [usedRow] = await options.db
      .select({ tokens: usage.tokens })
      .from(usage)
      .where(and(eq(usage.projectId, project.id), eq(usage.day, dayKey(at))))
    if ((usedRow?.tokens ?? 0) >= policy.dailyTokenBudget) {
      const reason = `项目今日 Token 预算已用尽（${usedRow?.tokens ?? 0} / ${policy.dailyTokenBudget}）`
      await finishTurn(options.db, turn.id, { status: 'failed', error: reason, at })
      await setTicketStage(options.db, ticket.id, 'failed', at)
      await options.db.update(agentSessions).set({ status: 'idle', updatedAt: at }).where(eq(agentSessions.id, turn.sessionId))
      if (ticket.channelId !== null) {
        await options.db
          .insert(outboxEvents)
          .values({
            id: newId(),
            projectId: project.id,
            channelId: ticket.channelId,
            kind: 'failed',
            dedupeKey: `budget:${turn.id}`,
            payload: { text: reason },
            status: 'pending',
            nextAttemptAt: at,
            createdAt: at,
          })
          .onConflictDoNothing({ target: outboxEvents.dedupeKey })
      }
      return true
    }
  }

  const currentStage = (ticket.stage ?? 'queued') as TicketStage
  const runningStage = currentStage === 'queued' || currentStage === 'idle' ? 'working' : currentStage
  if (runningStage !== currentStage) {
    await setTicketStage(options.db, ticket.id, runningStage, at)
  }

  const root = options.worktreeRoot ?? join(tmpdir(), 'superagent')
  const transcriptRoot = options.transcriptRoot ?? root
  let worktreePath = ticket.worktreePath ?? join(root, 'tickets', ticket.id)
  let transcriptPath = join(transcriptRoot, 'transcripts', `${ticket.id}.jsonl`)

  if (options.workspace !== undefined) {
    const workspace = await options.workspace.ensure({ project, ticket, turn })
    worktreePath = workspace.worktreePath
    transcriptPath = workspace.transcriptPath
    if (ticket.worktreePath !== worktreePath) {
      await setTicketWorktree(options.db, ticket.id, {
        branch: ticket.branch ?? branchName(ticket.shortName ?? ticket.id.slice(0, 8)),
        worktreePath,
        baseRef: ticket.baseRef,
        at,
      })
    }
  }

  const assignedBotId = turn.botId ?? ticket.botId ?? null
  const [assignedBot] =
    assignedBotId !== null ? await options.db.select().from(bots).where(eq(bots.id, assignedBotId)) : [undefined]
  const bus = options.events ?? defaultEventBus

  if (assignedBot) {
    await options.db.update(bots).set({ lastActiveAt: at, updatedAt: at }).where(eq(bots.id, assignedBot.id))
    bus.publish(project.id, 'bot.status', {
      botId: assignedBot.id,
      slug: assignedBot.slug,
      state: 'working',
      ticketId: ticket.id,
      turnId: turn.id,
    })
  }

  const inputs = await listUndeliveredInputs(options.db, ticket.id)
  await markInputsDelivered(options.db, inputs.map((input) => input.id), turn.id, at)
  const built = await buildPacket(options.db, project, ticket, turn, inputs, assignedBot ?? null)
  if (inputs.length > 0) {
    await options.db.insert(sessionMessages).values({
      id: newId(),
      projectId: project.id,
      sessionId: turn.sessionId,
      turnId: turn.id,
      role: 'user',
      content: inputs.map((input) => `[${input.source}] ${input.text}`).join('\n').slice(0, 20_000),
      createdAt: at,
    })
  }

  const controller = new AbortController()
  const heartbeatIntervalMs = options.heartbeatMs ?? 15_000
  const heartbeatTimer =
    heartbeatIntervalMs > 0
      ? setInterval(() => {
          void options.db
            .update(sessionTurns)
            .set({ heartbeatAt: options.now() })
            .where(and(eq(sessionTurns.id, turn.id), eq(sessionTurns.status, 'running')))
            .catch(() => {})
        }, heartbeatIntervalMs)
      : null
  const cancelTimer = setInterval(() => {
    void options.db
      .select({ status: sessionTurns.status, cancelRequestedAt: sessionTurns.cancelRequestedAt })
      .from(sessionTurns)
      .where(eq(sessionTurns.id, turn.id))
      .then(([row]) => {
        if (row?.status === 'cancelled' || row?.cancelRequestedAt !== null) controller.abort()
      })
      .catch(() => {})
  }, 1500)

  let resumeFrom: TurnResumeInput | undefined
  if (turn.kind === 'resume' && turn.input && typeof turn.input === 'object') {
    const meta = turn.input as { sourceTurnId?: string; decision?: string; comment?: string | null }
    if (typeof meta.sourceTurnId === 'string') {
      const [sourceTurn] = await options.db.select().from(sessionTurns).where(eq(sessionTurns.id, meta.sourceTurnId))
      const checkpoint = sourceTurn?.checkpoint as TurnCheckpoint | null | undefined
      if (checkpoint && (meta.decision === 'approved' || meta.decision === 'rejected' || meta.decision === 'revision_requested')) {
        resumeFrom = { checkpoint, decision: meta.decision, comment: meta.comment ?? null }
      }
    }
  }

  let report: Report
  let cancelled = false
  try {
    report = await options.executor.run({
      turnId: turn.id,
      sessionId: turn.sessionId,
      projectId: project.id,
      projectName: project.name,
      projectSlug: project.slug,
      ticketId: ticket.id,
      ticketShortName: ticket.shortName ?? ticket.id.slice(0, 8),
      ticketTitle: ticket.title,
      ticketBody: ticket.body,
      seq: turn.seq ?? 1,
      worktreePath,
      transcriptPath,
      inputs: inputs.map((input) => input.text),
      model: turn.model ?? assignedBot?.modelConfig?.model ?? null,
      prompt: built.prompt,
      packet: built.packet,
      ...(assignedBot?.toolPolicy ? { toolPolicy: assignedBot.toolPolicy } : {}),
      ...(resumeFrom ? { resumeFrom } : {}),
      timeoutMs: options.timeoutMs ?? policy.maxRunMinutes * 60_000,
      signal: controller.signal,
      ...(options.env === undefined ? {} : { env: options.env }),
      onEvent: async (event) => {
        const eventAt = options.now()
        await options.db
          .insert(turnEvents)
          .values({
            projectId: project.id,
            turnId: turn.id,
            type: event.type.slice(0, 80),
            message: event.message === undefined ? null : event.message.slice(0, 4000),
            payload: event.payload ?? null,
            createdAt: eventAt,
          })
          .catch(() => {})
        bus.publish(project.id, 'turn.event', {
          turnId: turn.id,
          ticketId: ticket.id,
          roomId: ticket.roomId,
          botId: assignedBot?.id ?? null,
          type: event.type,
          message: event.message ?? null,
          payload: event.payload ?? null,
          createdAt: eventAt.toISOString(),
        })
      },
    })
  } catch (error) {
    if (controller.signal.aborted) {
      cancelled = true
      report = { status: 'dropped', summary: '工单已取消' }
    } else {
      report = {
        status: 'failed',
        summary: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      }
    }
  } finally {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
    clearInterval(cancelTimer)
  }

  const finishedAt = options.now()

  if (cancelled) {
    await finishTurn(options.db, turn.id, { status: 'cancelled', error: 'cancelled', at: finishedAt })
    await options.db
      .update(agentSessions)
      .set({ status: 'idle', lastTurnAt: finishedAt, updatedAt: finishedAt })
      .where(eq(agentSessions.id, turn.sessionId))
    return true
  }

  // Tool-level Suggest-Don't-Send approval gate: persist checkpoint and release worker slot.
  if (report.approvalRequest !== undefined) {
    const req = report.approvalRequest
    const approvalId = newId()
    const expiresAt = new Date(finishedAt.getTime() + 24 * 3_600_000)
    await options.db.insert(actionApprovals).values({
      id: approvalId,
      projectId: project.id,
      roomId: ticket.roomId,
      ticketId: ticket.id,
      turnId: turn.id,
      botId: assignedBot?.id ?? null,
      toolName: req.toolName,
      toolCallId: req.toolCallId,
      riskLevel: req.riskLevel,
      title: req.title,
      preview: req.preview,
      toolArgs: req.toolArgs,
      status: 'pending',
      expiresAt,
      createdAt: finishedAt,
    })
    await options.db
      .update(sessionTurns)
      .set({
        status: 'waiting_approval',
        checkpoint: req.checkpoint,
        pausedApprovalId: approvalId,
        tokens: report.tokens ?? 0,
        cost: report.cost ?? 0,
        heartbeatAt: finishedAt,
      })
      .where(eq(sessionTurns.id, turn.id))
    await setTicketStage(options.db, ticket.id, 'waiting_approval', finishedAt)
    await options.db
      .update(agentSessions)
      .set({ status: 'idle', lastTurnAt: finishedAt, updatedAt: finishedAt })
      .where(eq(agentSessions.id, turn.sessionId))

    const previewBody = [
      `工具：\`${req.toolName}\`（风险等级：${req.riskLevel === 'high' ? '高' : '中'}）`,
      `预览：${JSON.stringify(req.preview).slice(0, 600)}`,
    ].join('\n')

    if (ticket.roomId) {
      await appendRoomMessage(options.db, {
        projectId: project.id,
        roomId: ticket.roomId,
        threadKey: ticket.threadKey ?? `room:${ticket.roomId}`,
        authorKind: assignedBot ? 'bot' : 'system',
        authorBotId: assignedBot?.id ?? null,
        kind: 'approval_card',
        content: `⏸️ 需要人工审批：${req.title}\n${previewBody}`,
        attachments: [{ type: 'approval', title: req.title, metadata: { approvalId, riskLevel: req.riskLevel } }],
        ticketId: ticket.id,
        turnId: turn.id,
        syncToIm: false,
        at: finishedAt,
        events: bus,
      })
    }
    if (ticket.channelId !== null) {
      await options.db
        .insert(outboxEvents)
        .values({
          id: newId(),
          projectId: project.id,
          channelId: ticket.channelId,
          kind: 'approval',
          dedupeKey: `approval:${approvalId}`,
          payload: {
            text: formatBotSignature(assignedBot, `⏸️ 待审批：${req.title}\n${previewBody}`),
            card: {
              title: `⏸️ 待审批：${req.title}`,
              body: formatBotSignature(assignedBot, previewBody),
              approvalId,
              projectId: project.id,
              riskLevel: req.riskLevel,
              status: 'pending',
            },
          },
          status: 'pending',
          nextAttemptAt: finishedAt,
          createdAt: finishedAt,
        })
        .onConflictDoNothing({ target: outboxEvents.dedupeKey })
    }
    bus.publish(project.id, 'approval.created', {
      approvalId,
      ticketId: ticket.id,
      botId: assignedBot?.id ?? null,
      toolName: req.toolName,
      riskLevel: req.riskLevel,
      title: req.title,
    })
    if (assignedBot) {
      bus.publish(project.id, 'bot.status', {
        botId: assignedBot.id,
        slug: assignedBot.slug,
        state: 'waiting_approval',
        ticketId: ticket.id,
        turnId: turn.id,
      })
    }
    return true
  }

  let deliveredCode = false
  if (report.status === 'ready' && options.delivery !== undefined) {
    try {
      const delivered = await options.delivery.deliver({
        project,
        ticket,
        report,
        worktreePath,
        at: finishedAt,
      })
      deliveredCode = delivered.committed || delivered.prUrl !== null
      report = {
        ...report,
        ...(delivered.branch === null ? {} : { branch: delivered.branch }),
        ...(delivered.prUrl === null ? {} : { prUrl: delivered.prUrl }),
      }
      if (delivered.branch !== null || delivered.prUrl !== null) {
        await setTicketDelivery(options.db, ticket.id, {
          branch: delivered.branch,
          prUrl: delivered.prUrl,
          at: finishedAt,
        })
      }
    } catch (error) {
      report = {
        status: 'failed',
        summary: `交付失败：${error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)}`,
      }
    }
  }

  const tokens = report.tokens ?? 0
  const cost = report.cost ?? 0
  const turnStatus = report.status === 'failed' ? 'failed' : 'succeeded'
  await finishTurn(options.db, turn.id, {
    status: turnStatus,
    result: report,
    error: report.status === 'failed' ? report.summary : null,
    tokens,
    cost,
    at: finishedAt,
  })

  await options.db.insert(auditLogs).values({
    projectId: project.id,
    actorId: null,
    actorLabel: 'core-worker',
    action: `turn.${turnStatus}`,
    target: `turn:${turn.id}`,
    metadata: { ticketId: ticket.id, status: report.status, tokens },
    createdAt: finishedAt,
  })

  const reportId = newId()
  await options.db.insert(reports).values({
    id: reportId,
    projectId: project.id,
    ticketId: ticket.id,
    assignmentId: null,
    turnId: turn.id,
    status: report.status,
    summary: report.summary,
    plan: report.plan ?? null,
    attentionQuestion: report.attentionQuestion ?? null,
    branch: report.branch ?? null,
    prUrl: report.prUrl ?? null,
    tokens,
    cost,
    raw: report as unknown as Record<string, unknown>,
    createdAt: finishedAt,
  })

  let next = stageForReport(runningStage, report, {
    planApprovalRequired: policy.planApproval === 'required',
    planApproved: ticket.planApprovedAt !== null,
    codeChanged: deliveredCode || (report.changedFiles?.length ?? 0) > 0,
  })

  // Handle explicit multi-bot handoff with maxHops + self-handoff + budget guards.
  let handoffNotice: string | null = null
  if (report.handoff !== undefined) {
    const targetSlug = report.handoff.toBotSlug.replace(/^@/, '').toLowerCase()
    const [targetBot] = await options.db
      .select()
      .from(bots)
      .where(and(eq(bots.projectId, project.id), eq(bots.slug, targetSlug), eq(bots.status, 'active')))
    const [roomRow] =
      ticket.roomId !== null ? await options.db.select().from(rooms).where(eq(rooms.id, ticket.roomId)) : [undefined]
    const maxHops = roomRow?.maxHandoffHops ?? 5
    const nextHop = (ticket.handoffHop ?? 0) + 1

    if (!targetBot) {
      handoffNotice = `无法交接：未找到启用中的 @${targetSlug}。`
    } else if (assignedBot && targetBot.id === assignedBot.id) {
      handoffNotice = `已拦截自交接：@${targetBot.slug} 不能连续交接给自己。`
    } else if (nextHop > maxHops) {
      next = 'blocked'
      handoffNotice = `多 Bot 接力已达到最大跳数上限（${maxHops} 跳），已暂停交接给 @${targetBot.slug}，请人工确认是否继续。`
    } else {
      const handoffText = [
        `@${targetBot.slug} ${report.handoff.summary}`,
        '',
        report.handoff.context,
        ...(report.handoff.expectedOutput ? ['', `期望产出：${report.handoff.expectedOutput}`] : []),
      ].join('\n')
      const chainId = ticket.handoffChainId ?? ticket.id
      if (ticket.roomId) {
        await appendRoomMessage(options.db, {
          projectId: project.id,
          roomId: ticket.roomId,
          threadKey: ticket.threadKey ?? `room:${ticket.roomId}`,
          authorKind: assignedBot ? 'bot' : 'system',
          authorBotId: assignedBot?.id ?? null,
          kind: 'handoff',
          content: handoffText,
          ticketId: ticket.id,
          turnId: turn.id,
          syncToIm: true,
          dedupeKey: `handoff-msg:${turn.id}`,
          at: finishedAt,
          events: bus,
        })
      }
      await receiveCoreTrigger(options.db, {
        projectId: project.id,
        channelId: ticket.channelId,
        roomId: ticket.roomId,
        provider: 'handoff',
        externalId: `handoff:${turn.id}:${targetBot.slug}`,
        kind: 'handoff',
        threadKey: ticket.threadKey ?? `handoff:${chainId}`,
        actorName: assignedBot?.name ?? 'Bot',
        text: handoffText,
        address: 'direct',
        isBot: true,
        mentionedBot: true,
        targetBotId: targetBot.id,
        sourceBotId: assignedBot?.id ?? null,
        handoffChainId: chainId,
        handoffHop: nextHop,
        authorized: project.status === 'active',
        at: finishedAt,
      })
    }
  }

  await setTicketStage(options.db, ticket.id, next, finishedAt)
  await options.db
    .update(tickets)
    .set({
      lastRunId: turn.id,
      lastReportId: reportId,
      ...(report.plan !== undefined && report.plan.length > 0 ? { plan: report.plan } : {}),
      updatedAt: finishedAt,
    })
    .where(eq(tickets.id, ticket.id))

  await options.db.insert(sessionMessages).values({
    id: newId(),
    projectId: project.id,
    sessionId: turn.sessionId,
    turnId: turn.id,
    role: 'assistant',
    content: (report.summary || report.status).slice(0, 20_000),
    createdAt: finishedAt,
  })

  await options.db
    .insert(usage)
    .values({ id: newId(), projectId: project.id, day: dayKey(finishedAt), runs: 1, tokens, cost })
    .onConflictDoUpdate({
      target: [usage.projectId, usage.day],
      set: {
        runs: sql`${usage.runs} + 1`,
        tokens: sql`${usage.tokens} + ${tokens}`,
        cost: sql`${usage.cost} + ${cost}`,
      },
    })

  const baseText = report.prUrl
    ? `PR 已创建：${report.prUrl}\n${report.summary}`
    : report.summary.length > 0
      ? report.summary
      : `[${ticket.shortName ?? ticket.id}] ${report.status}`
  const reportText = handoffNotice ? `${baseText}\n\n⚠️ ${handoffNotice}` : baseText

  if (ticket.roomId) {
    await appendRoomMessage(options.db, {
      projectId: project.id,
      roomId: ticket.roomId,
      threadKey: ticket.threadKey ?? `room:${ticket.roomId}`,
      authorKind: assignedBot ? 'bot' : 'system',
      authorBotId: assignedBot?.id ?? null,
      kind: 'report',
      content: reportText,
      attachments: report.prUrl ? [{ type: 'pr', title: 'Pull Request', url: report.prUrl }] : [],
      ticketId: ticket.id,
      turnId: turn.id,
      syncToIm: false,
      at: finishedAt,
      events: bus,
    })
  }

  if (ticket.channelId !== null) {
    await options.db
      .insert(outboxEvents)
      .values({
        id: newId(),
        projectId: project.id,
        channelId: ticket.channelId,
        kind: report.prUrl ? 'pr' : 'reply',
        dedupeKey: `report:${turn.id}`,
        payload: { text: formatBotSignature(assignedBot, reportText) },
        status: 'pending',
        nextAttemptAt: finishedAt,
        createdAt: finishedAt,
      })
      .onConflictDoNothing({ target: outboxEvents.dedupeKey })
  }

  await options.db
    .update(agentSessions)
    .set({ status: 'idle', lastTurnAt: finishedAt, updatedAt: finishedAt })
    .where(eq(agentSessions.id, turn.sessionId))

  if (assignedBot) {
    bus.publish(project.id, 'bot.status', {
      botId: assignedBot.id,
      slug: assignedBot.slug,
      state: 'idle',
      ticketId: ticket.id,
      turnId: turn.id,
    })
  }
  bus.publish(project.id, 'ticket.updated', {
    ticketId: ticket.id,
    shortName: ticket.shortName,
    stage: next,
    prUrl: report.prUrl ?? ticket.prUrl,
  })

  return true
}
