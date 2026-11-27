import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface EnsureMirrorInput {
  remoteUrl: string
  mirrorDir: string
  env?: Record<string, string>
}

export interface CreateWorktreeInput {
  mirrorDir: string
  worktreeDir: string
  branch: string
  baseRef?: string
  env?: Record<string, string>
}

export interface RemoveWorktreeInput {
  mirrorDir: string
  worktreeDir: string
  force?: boolean
}

export type RemoveWorktreeResult = 'removed' | 'dirty' | 'missing'

async function git(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await run('git', args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`git ${args[0] ?? ''} failed: ${message.slice(0, 2000)}`)
  }
}

/** Create or refresh the bare cache repo for one project. */
export async function ensureMirror(input: EnsureMirrorInput): Promise<void> {
  if (existsSync(`${input.mirrorDir}/HEAD`)) {
    // Ensure legacy `--mirror` clones don't wipe local `refs/heads/agent/*`
    // worktree branches on `fetch --prune` or block explicit push refspecs.
    await git(['--git-dir', input.mirrorDir, 'config', '--unset-all', 'remote.origin.mirror']).catch(() => {})
    await git(['--git-dir', input.mirrorDir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
    await git(['--git-dir', input.mirrorDir, 'fetch', '--prune', 'origin'], { env: input.env })
    return
  }
  await mkdir(dirname(input.mirrorDir), { recursive: true })
  await git(['clone', '--bare', input.remoteUrl, input.mirrorDir], { env: input.env })
  await git(['--git-dir', input.mirrorDir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
  await git(['--git-dir', input.mirrorDir, 'fetch', '--prune', 'origin'], { env: input.env })
}

async function resolveBaseRef(mirrorDir: string, requested?: string, env?: Record<string, string>): Promise<string> {
  const candidates = requested && requested !== 'HEAD'
    ? [`refs/remotes/origin/${requested}`, requested, 'refs/remotes/origin/HEAD', 'HEAD']
    : ['refs/remotes/origin/HEAD', 'HEAD']
  for (const ref of candidates) {
    const ok = await git(['--git-dir', mirrorDir, 'rev-parse', '--verify', ref], { ...(env ? { env } : {}) })
      .then(() => true)
      .catch(() => false)
    if (ok) return ref
  }
  return requested ?? 'HEAD'
}

/** Create a branch-backed worktree for one ticket, reusing an existing directory. */
export async function createTicketWorktree(input: CreateWorktreeInput): Promise<void> {
  if (existsSync(input.worktreeDir)) return
  await mkdir(dirname(input.worktreeDir), { recursive: true })
  const branchExists = await git(
    ['--git-dir', input.mirrorDir, 'rev-parse', '--verify', `refs/heads/${input.branch}`],
    { ...(input.env ? { env: input.env } : {}) },
  )
    .then(() => true)
    .catch(() => false)
  if (branchExists) {
    await git(['--git-dir', input.mirrorDir, 'worktree', 'add', input.worktreeDir, input.branch], {
      ...(input.env ? { env: input.env } : {}),
    })
    return
  }
  const baseRef = await resolveBaseRef(input.mirrorDir, input.baseRef, input.env)
  await git(
    [
      '--git-dir',
      input.mirrorDir,
      'worktree',
      'add',
      '-b',
      input.branch,
      input.worktreeDir,
      baseRef,
    ],
    { ...(input.env ? { env: input.env } : {}) },
  )
}

/** Remove a ticket worktree; dirty worktrees are kept unless force is set. */
export async function removeTicketWorktree(input: RemoveWorktreeInput): Promise<RemoveWorktreeResult> {
  if (!existsSync(input.worktreeDir)) return 'missing'
  const status = await git(['-C', input.worktreeDir, 'status', '--porcelain'])
  if (status.stdout.trim().length > 0 && input.force !== true) return 'dirty'
  await git(
    ['--git-dir', input.mirrorDir, 'worktree', 'remove', ...(input.force === true ? ['--force'] : []), input.worktreeDir],
    {},
  )
  return 'removed'
}
