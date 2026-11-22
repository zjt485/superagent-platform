import { join } from 'node:path'

import type { ProjectRow, TicketRow, TurnRow } from '../../db/schema.js'
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
  remoteUrl: (project: ProjectRow) => string
  env?: Record<string, string>
  branchPrefix?: string
}

/** Server-side mirror + per-ticket worktree provider. */
export class GitWorkspaceProvider implements WorkspaceProvider {
  constructor(private readonly options: GitWorkspaceProviderOptions) {}

  async ensure(input: EnsureWorkspaceInput): Promise<Workspace> {
    const mirrorDir = join(this.options.rootDir, 'projects', input.project.id, 'repo.git')
    const worktreeDir = join(this.options.rootDir, 'tickets', input.ticket.id)
    const branch =
      input.ticket.branch ??
      branchName(input.ticket.shortName ?? ticketShortName(), this.options.branchPrefix ?? 'agent/')

    await ensureMirror({
      remoteUrl: this.options.remoteUrl(input.project),
      mirrorDir,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
    })
    await createTicketWorktree({
      mirrorDir,
      worktreeDir,
      branch,
      baseRef: input.ticket.baseRef ?? 'HEAD',
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
    })

    return {
      worktreePath: worktreeDir,
      transcriptPath: join(this.options.rootDir, 'transcripts', `${input.ticket.id}.jsonl`),
    }
  }
}
