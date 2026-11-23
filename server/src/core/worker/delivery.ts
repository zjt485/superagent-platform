import { eq } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import { repos, type ProjectRow, type TicketRow } from '../../db/schema.js'
import type { GitHubPort } from '../../domain/github.js'
import { branchName } from '../domain/ids.js'
import type { Report } from '../domain/types.js'
import type { GitOps } from '../../worker/git.js'
import { gitAuthEnv } from '../../worker/git.js'

export interface DeliveryInput {
  project: ProjectRow
  ticket: TicketRow
  report: Report
  worktreePath: string
  at: Date
}

export interface DeliveryResult {
  branch: string | null
  prUrl: string | null
  committed: boolean
}

export interface DeliveryProvider {
  deliver(input: DeliveryInput): Promise<DeliveryResult>
}

export interface GitDeliveryOptions {
  db: Database
  git: GitOps
  github: GitHubPort
  author: { name: string; email: string }
  branchPrefix?: string
  webBase?: string
}

/** Commit the ticket worktree, push its branch and open (or reuse) a PR. */
export class GitDeliveryProvider implements DeliveryProvider {
  constructor(private readonly options: GitDeliveryOptions) {}

  async deliver(input: DeliveryInput): Promise<DeliveryResult> {
    const [repo] = await this.options.db.select().from(repos).where(eq(repos.projectId, input.project.id))
    if (repo === undefined) {
      return { branch: input.ticket.branch, prUrl: input.ticket.prUrl, committed: false }
    }

    const branch =
      input.ticket.branch ??
      branchName(input.ticket.shortName ?? input.ticket.id.slice(0, 8), this.options.branchPrefix ?? 'agent/')

    if (repo.provider === 'local') {
      const committed = await this.options.git.createBranchAndCommit({
        dir: input.worktreePath,
        branch,
        message: `feat: ${input.ticket.title.slice(0, 120)}\n\nSuperagent ticket ${input.ticket.id}`,
        author: this.options.author,
        env: {},
      })
      return { branch, prUrl: null, committed }
    }

    const token = await this.options.github.installationToken(repo.installationId)
    const env = gitAuthEnv(token, this.options.webBase ?? 'https://github.com')

    const committed = await this.options.git.createBranchAndCommit({
      dir: input.worktreePath,
      branch,
      message: `feat: ${input.ticket.title.slice(0, 120)}\n\nSuperagent ticket ${input.ticket.id}`,
      author: this.options.author,
      env,
    })
    if (!committed) return { branch, prUrl: input.ticket.prUrl, committed: false }

    await this.options.git.push({ dir: input.worktreePath, branch, env })
    if (input.ticket.prUrl !== null) return { branch, prUrl: input.ticket.prUrl, committed: true }

    const [owner, name] = repo.fullName.split('/')
    if (owner === undefined || name === undefined) throw new Error(`invalid repository: ${repo.fullName}`)
    const pr = await this.options.github.createPullRequest({
      installationId: repo.installationId,
      owner,
      name,
      head: branch,
      base: repo.defaultBranch,
      title: `[Superagent] ${input.ticket.title.slice(0, 120)}`,
      body: [
        '## 需求',
        input.ticket.body.slice(0, 4000),
        '',
        '## 计划',
        (input.report.plan ?? input.ticket.plan ?? '（未记录）').slice(0, 4000),
        '',
        '## Executor 报告',
        input.report.summary.slice(0, 4000),
        '',
        `> 工单 ${input.ticket.id} · 由 Superagent core worker 生成`,
      ].join('\n'),
    })
    return { branch, prUrl: pr.url, committed: true }
  }
}
