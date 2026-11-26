import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import { repos, type ProjectRow, type TicketRow, type TurnRow } from '../../db/schema.js'
import type { GitHubPort } from '../../domain/github.js'
import { gitAuthEnv } from '../../worker/git.js'
import { branchName, ticketShortName } from '../domain/ids.js'
import { createTicketWorktree, ensureMirror } from './worktree.js'

export interface EnsureWorkspaceInput {
  project: ProjectRow
  ticket: TicketRow
  turn: TurnRow
}

export interface Workspace {
  worktreePath: string
  transcriptPath: string
}

export interface WorkspaceProvider {
  ensure(input: EnsureWorkspaceInput): Promise<Workspace>
}

export interface GitWorkspaceProviderOptions {
  rootDir: string
  remoteUrl: (project: ProjectRow) => string | null | Promise<string | null>
  env?: Record<string, string>
  envForProject?: (project: ProjectRow) => Record<string, string> | Promise<Record<string, string>>
  branchPrefix?: string
}

/** Server-side mirror + per-ticket worktree provider (falls back to scratch dir if no repo). */
export class GitWorkspaceProvider implements WorkspaceProvider {
  constructor(private readonly options: GitWorkspaceProviderOptions) {}

  async ensure(input: EnsureWorkspaceInput): Promise<Workspace> {
    const worktreeDir = join(this.options.rootDir, 'tickets', input.ticket.id)
    const transcriptPath = join(this.options.rootDir, 'transcripts', `${input.ticket.id}.jsonl`)
    const remoteUrl = await this.options.remoteUrl(input.project)

    if (remoteUrl === null) {
      await mkdir(worktreeDir, { recursive: true })
      return { worktreePath: worktreeDir, transcriptPath }
    }

    const mirrorDir = join(this.options.rootDir, 'projects', input.project.id, 'repo.git')
    const branch =
      input.ticket.branch ??
      branchName(input.ticket.shortName ?? ticketShortName(), this.options.branchPrefix ?? 'agent/')
    const env =
      this.options.envForProject !== undefined
        ? await this.options.envForProject(input.project)
        : this.options.env

    await ensureMirror({
      remoteUrl,
      mirrorDir,
      ...(env === undefined ? {} : { env }),
    })
    await createTicketWorktree({
      mirrorDir,
      worktreeDir,
      branch,
      baseRef: input.ticket.baseRef ?? 'HEAD',
      ...(env === undefined ? {} : { env }),
    })

    return { worktreePath: worktreeDir, transcriptPath }
  }
}

export interface DbWorkspaceProviderOptions {
  db: Database
  rootDir: string
  github: GitHubPort
  webBase: string
  branchPrefix?: string
}

/**
 * Dynamic workspace provider backed by the `repos` table.
 * - No bound repo → persistent scratch directory for the ticket.
 * - Local repo (`provider === 'local'`) → mirrors the local git directory.
 * - GitHub repo in mock mode → persistent scratch directory (no network clone).
 * - GitHub repo in real app mode → mirrors GitHub with short-lived installation token.
 */
export function createDbWorkspaceProvider(options: DbWorkspaceProviderOptions): WorkspaceProvider {
  return new GitWorkspaceProvider({
    rootDir: options.rootDir,
    ...(options.branchPrefix === undefined ? {} : { branchPrefix: options.branchPrefix }),
    remoteUrl: async (project) => {
      const [repo] = await options.db.select().from(repos).where(eq(repos.projectId, project.id))
      if (repo === undefined) return null
      if (repo.provider === 'local') return repo.fullName
      if (options.github.mode === 'mock') return null
      return `${options.webBase.replace(/\/+$/, '')}/${repo.fullName}.git`
    },
    envForProject: async (project) => {
      const [repo] = await options.db.select().from(repos).where(eq(repos.projectId, project.id))
      if (repo === undefined || repo.provider === 'local' || options.github.mode === 'mock') {
        return {}
      }
      const token = await options.github.installationToken(repo.installationId)
      return gitAuthEnv(token, options.webBase)
    },
  })
}
