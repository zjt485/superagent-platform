import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { GitHubPort } from '../domain/github.js'
import { shortId } from '../domain/ids.js'
import { parsePolicy } from '../domain/policy.js'
import { audit } from '../services/audit.js'
import {
  agentSessions,
  evaluations,
  projects,
  repos,
  sessionMessages,
  sessionTurns,
  tickets,
  type ProjectRow,
  type TicketRow,
} from '../db/schema.js'
import { newId } from '../domain/ids.js'
import type { DualContext } from './engine.js'
import {
  applyExecutorReport,
  applyMainDecision,
  buildExecutorPacket,
  buildMainPacket,
  markInputsDelivered,
} from './engine.js'
import { buildExecutorPrompt, buildMainPrompt } from './prompts.js'
import type { TurnRuntime } from './types.js'
import { TurnCancelledError, EXECUTOR_REPORT_OUTPUT } from './types.js'
import { finishTurn, recordTurnEvent, type TurnRow } from './sessions.js'
import type { GitOps } from '../worker/git.js'
import { gitAuthEnv } from '../worker/git.js'

export interface DualWorkerContext extends DualContext {
  ports: {
    github: GitHubPort
    git: GitOps
    runtime: TurnRuntime
  }
  heartbeatMs?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function mainWorkspace(config: { WORKSPACES_DIR: string }, projectId: string): string {
  return path.resolve(config.WORKSPACES_DIR, projectId, 'main')
}

export function ticketWorkspace(config: { WORKSPACES_DIR: string }, projectId: string, ticketId: string): string {
  return path.resolve(config.WORKSPACES_DIR, projectId, 'tickets', ticketId)
}

function branchFor(prefix: string, ticket: TicketRow): string {
  if (ticket.branch) return ticket.branch
  const safe = prefix.startsWith('agent/') ? prefix : 'agent/'
  return `${safe}${shortId(ticket.id)}`
}

async function projectOf(ctx: DualWorkerContext, projectId: string): Promise<ProjectRow> {
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId))
  if (!project) throw new Error('project not found')
  return project
}

async function isCancelled(ctx: DualWorkerContext, turnId: string): Promise<boolean> {
  const [row] = await ctx.db.select({ status: sessionTurns.status, cancelRequestedAt: sessionTurns.cancelRequestedAt }).from(sessionTurns).where(eq(sessionTurns.id, turnId))
  return row?.status === 'cancelled' || Boolean(row?.cancelRequestedAt)
}

/**
 * Executes one Main-Session eval or Executor-Session turn. All model calls go
 * through `ports.runtime`; the worker owns repository delivery and state
 * transitions so the agent may only edit its workspace.
 */
export async function executeTurn(ctx: DualWorkerContext, turn: TurnRow): Promise<void> {
  const log = ctx.log.child({ turnId: turn.id, projectId: turn.projectId, ticketId: turn.ticketId })
  const controller = new AbortController()
  let watcher: NodeJS.Timeout | undefined
  let heartbeat: NodeJS.Timeout | undefined
  const startedAt = Date.now()

  try {
    const project = await projectOf(ctx, turn.projectId)
    const policy = parsePolicy(project.policyJson)
    const [session] = await ctx.db.select().from(agentSessions).where(eq(agentSessions.id, turn.sessionId))
    if (!session) throw new Error('session not found')

    watcher = setInterval(() => {
      void isCancelled(ctx, turn.id)
        .then((cancelled) => cancelled && controller.abort())
        .catch(() => {})
    }, 1500)
    heartbeat = setInterval(() => {
      void ctx.db
        .update(sessionTurns)
        .set({ heartbeatAt: ctx.now() })
        .where(and(eq(sessionTurns.id, turn.id), eq(sessionTurns.status, 'running')))
        .catch(() => {})
    }, ctx.heartbeatMs ?? 15_000)

    if (turn.kind === 'eval') {
      await executeEval(ctx, turn, project, policy, session.id, controller.signal)
    } else {
      await executeExecutor(ctx, turn, project, policy, session.id, controller.signal)
    }
  } catch (error) {
    const cancelled = error instanceof TurnCancelledError || controller.signal.aborted || (await isCancelled(ctx, turn.id).catch(() => false))
    if (cancelled) {
      await finishTurn(ctx, turn, { status: 'cancelled', error: 'cancelled by user' }).catch(() => {})
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    log.error({ err: error }, 'turn failed')
    await finishTurn(ctx, turn, { status: 'failed', error: message }).catch(() => {})
    if (turn.kind === 'eval' && turn.evaluationId) {
      await ctx.db
        .update(evaluations)
        .set({ status: 'unavailable', reason: message.slice(0, 500), endedAt: ctx.now() })
        .where(eq(evaluations.id, turn.evaluationId))
        .catch(() => {})
    } else if (turn.ticketId) {
      await applyExecutorReport(
        ctx,
        turn.id,
        {},
        { status: 'failed', summary: `Executor 运行失败：${message}` },
      ).catch((reportError) => log.error({ err: reportError }, 'failed to record failed report'))
    }
  } finally {
    if (watcher) clearInterval(watcher)
    if (heartbeat) clearInterval(heartbeat)
    log.info({ durationMs: Date.now() - startedAt }, 'turn finished')
  }
}

async function executeEval(
  ctx: DualWorkerContext,
  turn: TurnRow,
  project: ProjectRow,
  policy: ReturnType<typeof parsePolicy>,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  if (!turn.evaluationId) throw new Error('eval turn has no evaluation')
  const [evaluation] = await ctx.db.select().from(evaluations).where(eq(evaluations.id, turn.evaluationId))
  if (!evaluation) throw new Error('evaluation not found')
  await ctx.db
    .update(evaluations)
    .set({ status: 'running', startedAt: ctx.now(), attempts: evaluation.attempts + 1 })
    .where(eq(evaluations.id, evaluation.id))

  const packet = await buildMainPacket(ctx, turn.id)
  const mainDir = mainWorkspace(ctx.config, project.id)
  await mkdir(mainDir, { recursive: true })
  await ctx.db.insert(sessionMessages).values({
    id: newId(),
    projectId: project.id,
    sessionId,
    turnId: turn.id,
    role: 'user',
    content: `本批 Triggers：${packet.thread.triggers.map((trigger) => trigger.text).join(' / ').slice(0, 4000)}`,
    createdAt: ctx.now(),
  })
  const prompt = buildMainPrompt(packet)
  const result = await ctx.ports.runtime.run({
    role: 'main',
    projectId: project.id,
    sessionId,
    turnId: turn.id,
    workspace: mainDir,
    prompt,
    packet,
    timeoutMs: Math.min(policy.maxRunMinutes, ctx.config.AGENT_TIMEOUT_MINUTES) * 60_000,
    signal,
    env: {},
    onEvent: (event) => recordTurnEvent(ctx, turn, event),
  })
  await applyMainDecision(ctx, turn.id, result.output)
  await finishTurn(ctx, turn, { status: 'succeeded', result: result.output, tokens: result.tokens, cost: result.cost })
  await ctx.db.update(evaluations).set({ status: 'decided', endedAt: ctx.now() }).where(eq(evaluations.id, evaluation.id))
}

async function executeExecutor(
  ctx: DualWorkerContext,
  turn: TurnRow,
  project: ProjectRow,
  policy: ReturnType<typeof parsePolicy>,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  if (!turn.ticketId) throw new Error('executor turn has no ticket')
  const [ticket] = await ctx.db.select().from(tickets).where(eq(tickets.id, turn.ticketId))
  if (!ticket) throw new Error('ticket not found')
  if (ticket.stage === 'done' || ticket.stage === 'cancelled') throw new TurnCancelledError()
  const [repo] = await ctx.db.select().from(repos).where(eq(repos.projectId, project.id))
  const workspace = ticketWorkspace(ctx.config, project.id, ticket.id)
  await mkdir(workspace, { recursive: true })

  let workspaceReady = existsSync(path.join(workspace, '.git'))
  let authEnv: Record<string, string> = {}
  if (repo) {
    const token = await ctx.ports.github.installationToken(repo.installationId)
    authEnv = gitAuthEnv(token, ctx.config.GITHUB_WEB_BASE)
    if (!workspaceReady) {
      await ctx.ports.git.clone({
        url: ctx.ports.github.remoteUrl(repo.fullName),
        dir: workspace,
        branch: repo.defaultBranch,
        env: authEnv,
      })
      workspaceReady = true
    }
  }

  await ctx.db.update(tickets).set({ status: 'running', stage: 'working', updatedAt: ctx.now() }).where(eq(tickets.id, ticket.id))
  const packet = await buildExecutorPacket(ctx, turn.id, workspaceReady)
  const prompt = buildExecutorPrompt(packet)
  await ctx.db.insert(sessionMessages).values({
    id: newId(),
    projectId: project.id,
    sessionId,
    turnId: turn.id,
    role: 'user',
    content: packet.inputs.length > 0 ? packet.inputs.map((input) => input.text).join('\n').slice(0, 2000) : '开始执行工单。',
    createdAt: ctx.now(),
  })

  const result = await ctx.ports.runtime.run({
    role: 'executor',
    projectId: project.id,
    sessionId,
    turnId: turn.id,
    ticketId: ticket.id,
    workspace,
    prompt,
    packet,
    timeoutMs: Math.min(policy.maxRunMinutes, ctx.config.AGENT_TIMEOUT_MINUTES) * 60_000,
    signal,
    env: {},
    onEvent: (event) => recordTurnEvent(ctx, turn, event),
  })

  const parsed = EXECUTOR_REPORT_OUTPUT.parse(result.output)
  let branch: string | null = ticket.branch
  let prUrl: string | null = ticket.prUrl

  const shouldDeliver = parsed.status === 'ready' && repo && !isPlanGate(packet, parsed)
  if (shouldDeliver) {
    branch = branchFor(policy.branchPrefix, ticket)
    const committed = await ctx.ports.git.createBranchAndCommit({
      dir: workspace,
      branch,
      message: `feat: ${ticket.title.slice(0, 120)}\n\nSuperagent ticket ${ticket.id}`,
      author: { name: ctx.config.GIT_AUTHOR_NAME, email: ctx.config.GIT_AUTHOR_EMAIL },
      env: authEnv,
    })
    if (committed) {
      await ctx.ports.git.push({ dir: workspace, branch, env: authEnv })
      if (!prUrl) {
        const pr = await ctx.ports.github.createPullRequest({
          installationId: repo.installationId,
          owner: repo.owner,
          name: repo.name,
          head: branch,
          base: repo.defaultBranch,
          title: `[Superagent] ${ticket.title.slice(0, 120)}`,
          body: [
            '## 需求',
            ticket.body.slice(0, 4000),
            '',
            '## 计划',
            (packet.ticket.plan ?? parsed.plan ?? '（未记录）').slice(0, 4000),
            '',
            '## Executor 报告',
            parsed.summary.slice(0, 4000),
            '',
            `> 工单 ${ticket.id} · 由 Superagent Executor Session 生成`,
          ].join('\n'),
        })
        prUrl = pr.url
        await audit(ctx, {
          projectId: project.id,
          action: 'github.pr_opened',
          target: `ticket:${ticket.id}`,
          metadata: { prUrl, branch, number: pr.number },
        })
      }
    }
  }

  await markInputsDelivered(ctx, ticket.id, packet.inputs.map((input) => input.id), true)
  await applyExecutorReport(ctx, turn.id, { branch, prUrl }, parsed)
  await finishTurn(ctx, turn, { status: 'succeeded', result: parsed, tokens: result.tokens, cost: result.cost })
}

function isPlanGate(packet: Awaited<ReturnType<typeof buildExecutorPacket>>, report: { plan?: string; status: string }): boolean {
  return packet.project.policy.planApproval === 'required' && !packet.ticket.planApproved && Boolean(report.plan)
}
