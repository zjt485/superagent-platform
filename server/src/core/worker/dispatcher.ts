import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import {
  agentSessions,
  mandates,
  outboxEvents,
  projects,
  reports,
  sessionMessages,
  sessionTurns,
  tickets,
  type ProjectRow,
  type TicketInputRow,
  type TicketRow,
  type TurnRow,
} from '../../db/schema.js'
import { buildExecutorPrompt } from '../../dual/prompts.js'
import type { ExecutorTurnPacket } from '../../dual/types.js'
import { newId } from '../../domain/ids.js'
import { nextStage } from '../domain/stage.js'
import type { Report, TicketStage } from '../domain/types.js'
import { listUndeliveredInputs, markInputsDelivered } from '../store/inputs.js'
import { setTicketStage, setTicketWorktree } from '../store/tickets.js'
import { finishTurn } from '../store/turns.js'
import { branchName } from '../domain/ids.js'
import type { Executor } from './executor.js'
import type { WorkspaceProvider } from './workspace-provider.js'

export interface DispatcherOptions {
  db: Database
  executor: Executor
  now: () => Date
  worktreeRoot?: string
  transcriptRoot?: string
  timeoutMs?: number
  env?: Record<string, string>
  workspace?: WorkspaceProvider
}

async function claimNextTurn(db: Database, at: Date): Promise<TurnRow | undefined> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(sessionTurns)
      .where(
        and(
          eq(sessionTurns.status, 'queued'),
          eq(sessionTurns.kind, 'execute'),
          isNotNull(sessionTurns.ticketId),
        ),
      )
      .orderBy(asc(sessionTurns.createdAt))
      .limit(20)
      .for('update', { skipLocked: true })

    for (const candidate of candidates) {
      if (candidate.ticketId === null) continue
      const [running] = await tx
        .select({ id: sessionTurns.id })
        .from(sessionTurns)
        .where(and(eq(sessionTurns.ticketId, candidate.ticketId), eq(sessionTurns.status, 'running')))
        .limit(1)
      if (running !== undefined) continue
      const [claimed] = await tx
        .update(sessionTurns)
        .set({ status: 'running', startedAt: at, heartbeatAt: at })
        .where(eq(sessionTurns.id, candidate.id))
        .returning()
      return claimed
    }
    return undefined
  })
}

function stageForReport(current: TicketStage, report: Report): TicketStage {
  try {
    switch (report.status) {
      case 'progress':
        return nextStage(current, { type: 'progress' })
      case 'waiting':
        return nextStage(current, { type: 'waiting', plan: report.plan !== undefined })
      case 'ready':
        return nextStage(current, { type: 'ready', codeChanged: (report.changedFiles?.length ?? 0) > 0 })
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

  const packet: ExecutorTurnPacket = {
    role: 'executor',
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
    return true
  }
  const [project] = await options.db.select().from(projects).where(eq(projects.id, ticket.projectId))
  if (project === undefined) {
    await finishTurn(options.db, turn.id, { status: 'failed', error: 'project missing', at })
    return true
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

  const inputs = await listUndeliveredInputs(options.db, ticket.id)
  await markInputsDelivered(options.db, inputs.map((input) => input.id), turn.id, at)
  const built = await buildPacket(options.db, project, ticket, turn, inputs)

  let report: Report
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
      model: turn.model ?? null,
      prompt: built.prompt,
      packet: built.packet,
      timeoutMs: options.timeoutMs ?? 45 * 60_000,
      ...(options.env === undefined ? {} : { env: options.env }),
    })
  } catch (error) {
    report = {
      status: 'failed',
      summary: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    }
  }

  await finishTurn(options.db, turn.id, {
    status: report.status === 'failed' ? 'failed' : 'succeeded',
    result: report,
    error: report.status === 'failed' ? report.summary : null,
    tokens: report.tokens ?? 0,
    cost: report.cost ?? 0,
    at,
  })
  await options.db.insert(reports).values({
    id: newId(),
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
    tokens: report.tokens ?? 0,
    cost: report.cost ?? 0,
    raw: report as unknown as Record<string, unknown>,
    createdAt: at,
  })
  await setTicketStage(options.db, ticket.id, stageForReport(runningStage, report), at)

  await options.db
    .insert(outboxEvents)
    .values({
      id: newId(),
      projectId: project.id,
      channelId: ticket.channelId,
      kind: 'reply',
      dedupeKey: `report:${turn.id}`,
      payload: { text: report.summary.length > 0 ? report.summary : `[${ticket.shortName ?? ticket.id}] ${report.status}` },
      status: 'pending',
      nextAttemptAt: at,
      createdAt: at,
    })
    .onConflictDoNothing({ target: outboxEvents.dedupeKey })

  await options.db
    .update(agentSessions)
    .set({ status: 'idle', lastTurnAt: at, updatedAt: at })
    .where(eq(agentSessions.id, turn.sessionId))

  return true
}
