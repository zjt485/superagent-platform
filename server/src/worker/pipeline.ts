import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import type { OrchestratorContext } from '../services/orchestrator.js'
import { completeExecution, completePlan, failRun, projectForTicket } from '../services/orchestrator.js'
import { getTicketById } from '../services/tickets.js'
import { finishRun, heartbeatRun, isRunCancelled, recordRunEvent } from '../services/runs.js'
import { audit } from '../services/audit.js'
import { messages, repos, type RunRow, type TicketRow } from '../db/schema.js'
import type { GitHubPort } from '../domain/github.js'
import { parsePolicy } from '../domain/policy.js'
import { RuntimeCancelledError, type AgentRuntime } from '../domain/runtime.js'
import { shortId } from '../domain/ids.js'
import type { GitOps } from './git.js'
import { gitAuthEnv } from './git.js'
import { buildPrompt } from './prompt.js'

export interface WorkerPorts {
  github: GitHubPort
  git: GitOps
  runtime: AgentRuntime
}

export interface WorkerContext extends OrchestratorContext {
  ports: WorkerPorts
  heartbeatMs?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function branchName(prefix: string, ticketId: string): string {
  const safePrefix = prefix.startsWith('agent/') ? prefix : 'agent/'
  return `${safePrefix}${shortId(ticketId)}-${Date.now().toString(36)}`
}

export function workspaceFor(config: { WORKSPACES_DIR: string }, projectId: string, runId: string): string {
  return path.resolve(config.WORKSPACES_DIR, projectId, runId)
}

async function recentMessages(ctx: WorkerContext, ticket: TicketRow) {
  if (!ticket.threadKey) return []
  const rows = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.projectId, ticket.projectId), eq(messages.threadKey, ticket.threadKey)))
    .orderBy(desc(messages.createdAt))
    .limit(20)
  return rows
    .reverse()
    .map((row) => ({ sender: row.senderName ?? '成员', text: row.text, at: row.createdAt }))
}

/**
 * Executes one claimed run end to end: clone, agent, commit, push, PR, and the
 * ticket transition. Shared by the worker process, demos and tests.
 */
export async function executeClaimedRun(ctx: WorkerContext, run: RunRow): Promise<void> {
  const log = ctx.log.child({ runId: run.id, projectId: run.projectId, ticketId: run.ticketId })
  let workspace: string | null = null
  let heartbeat: NodeJS.Timeout | undefined
  let watcher: NodeJS.Timeout | undefined
  const controller = new AbortController()

  try {
    const ticket = await getTicketById(ctx, run.ticketId)
    const project = await projectForTicket(ctx, ticket)
    const [repo] = await ctx.db.select().from(repos).where(eq(repos.projectId, project.id))
    if (!repo) {
      await failRun(ctx, run.id, { reason: '项目尚未绑定 GitHub 仓库' })
      return
    }
    if (ticket.status === 'cancelled') {
      await finishRun(ctx, run.id, { status: 'cancelled', error: 'ticket cancelled' })
      return
    }
    if (await isRunCancelled(ctx, run.id)) {
      await finishRun(ctx, run.id, { status: 'cancelled', error: 'cancelled before start' })
      return
    }

    const policy = parsePolicy(project.policyJson)
    workspace = workspaceFor(ctx.config, project.id, run.id)
    await mkdir(workspace, { recursive: true })
    await recordRunEvent(ctx, run.id, { type: 'workspace', message: workspace })

    const token = await ctx.ports.github.installationToken(repo.installationId)
    const authEnv = gitAuthEnv(token, ctx.config.GITHUB_WEB_BASE)

    await ctx.ports.git.clone({
      url: ctx.ports.github.remoteUrl(repo.fullName),
      dir: workspace,
      branch: repo.defaultBranch,
      env: authEnv,
    })
    await recordRunEvent(ctx, run.id, { type: 'clone', message: `cloned ${repo.fullName}@${repo.defaultBranch}` })

    if (await isRunCancelled(ctx, run.id)) {
      await finishRun(ctx, run.id, { status: 'cancelled', error: 'cancelled during clone' })
      return
    }

    const threadMessages = await recentMessages(ctx, ticket)
    const prompt = buildPrompt({ kind: run.kind, project, ticket, repo, messages: threadMessages })
    const timeoutMs = Math.min(policy.maxRunMinutes, ctx.config.AGENT_TIMEOUT_MINUTES) * 60_000

    heartbeat = setInterval(() => {
      void heartbeatRun(ctx, run.id).catch(() => {})
    }, ctx.heartbeatMs ?? 15_000)
    watcher = setInterval(() => {
      void isRunCancelled(ctx, run.id)
        .then((cancelled) => {
          if (cancelled) controller.abort()
        })
        .catch(() => {})
    }, 2_000)

    log.info({ kind: run.kind, workspace }, 'agent runtime starting')
    const result = await ctx.ports.runtime.run({
      runId: run.id,
      projectId: project.id,
      ticketId: ticket.id,
      kind: run.kind,
      workspace,
      prompt,
      // The agent edits the working tree only; the installation token stays in
      // the worker and is never exposed to the model process.
      env: {},
      timeoutMs,
      signal: controller.signal,
      onEvent: async (event) => {
        await recordRunEvent(ctx, run.id, {
          type: event.type,
          message: event.message ?? null,
          payload: event.payload ?? null,
        }).catch((error) => log.warn({ err: error }, 'failed to record run event'))
      },
    })

    if (controller.signal.aborted || (await isRunCancelled(ctx, run.id))) {
      await finishRun(ctx, run.id, { status: 'cancelled', error: 'cancelled by user' })
      return
    }

    if (run.kind === 'plan') {
      await completePlan(ctx, run.id, {
        plan: result.plan ?? result.summary,
        tokens: result.tokens,
        cost: result.cost,
      })
      return
    }

    const branch = branchName(policy.branchPrefix, ticket.id)
    const committed = await ctx.ports.git.createBranchAndCommit({
      dir: workspace,
      branch,
      message: `feat: ${ticket.title.slice(0, 120)}\n\nSuperagent ticket ${ticket.id}`,
      author: { name: ctx.config.GIT_AUTHOR_NAME, email: ctx.config.GIT_AUTHOR_EMAIL },
      env: authEnv,
    })
    if (!committed) {
      await failRun(ctx, run.id, { reason: 'Agent 未产生任何仓库改动，无法创建 PR', tokens: result.tokens, cost: result.cost })
      return
    }
    if (await isRunCancelled(ctx, run.id)) {
      await finishRun(ctx, run.id, { status: 'cancelled', error: 'cancelled before push' })
      return
    }
    await ctx.ports.git.push({ dir: workspace, branch, env: authEnv })
    await recordRunEvent(ctx, run.id, { type: 'push', message: `pushed ${branch}` })

    const diff = await ctx.ports.git.diffStat(workspace).catch(() => '')
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
        ticket.plan?.slice(0, 4000) ?? '（未记录）',
        '',
        '## Agent 摘要',
        result.summary.slice(0, 4000),
        '',
        diff ? '```diff\n' + diff + '\n```' : '',
        '',
        `> 工单 ${ticket.id} · 由 Superagent 创建，等待人工评审后合并。`,
      ].join('\n'),
    })
    await audit(ctx, {
      projectId: project.id,
      action: 'github.pr_opened',
      target: `ticket:${ticket.id}`,
      metadata: { prUrl: pr.url, branch, number: pr.number },
    })
    await completeExecution(ctx, run.id, {
      summary: result.summary,
      prUrl: pr.url,
      branch,
      tokens: result.tokens,
      cost: result.cost,
    })
  } catch (error) {
    const cancelled =
      error instanceof RuntimeCancelledError || controller.signal.aborted || (await isRunCancelled(ctx, run.id).catch(() => false))
    if (cancelled) {
      await finishRun(ctx, run.id, { status: 'cancelled', error: 'cancelled by user' }).catch(() => {})
      return
    }
    const reason = error instanceof Error ? error.message : String(error)
    log.error({ err: error }, 'run failed')
    await failRun(ctx, run.id, { reason }).catch((failure) => log.error({ err: failure }, 'failed to record run failure'))
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    if (watcher) clearInterval(watcher)
    if (workspace && !ctx.config.KEEP_WORKSPACES) {
      await rm(workspace, { recursive: true, force: true }).catch((error) => log.warn({ err: error }, 'workspace cleanup failed'))
    }
  }
}

export { sleep }
