import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createTicketWorktree,
  ensureMirror,
  removeTicketWorktree,
} from '../../src/core/worker/worktree.js'

const run = promisify(execFile)
const roots: string[] = []

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await run('git', args, { cwd, windowsHide: true })
  return result.stdout
}

async function makeOrigin(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sa-worktree-'))
  roots.push(root)
  const origin = join(root, 'origin')
  await mkdir(origin, { recursive: true })
  await git(origin, ['init', '-q'])
  await git(origin, ['config', 'user.name', 'Test'])
  await git(origin, ['config', 'user.email', 'test@example.com'])
  await writeFile(join(origin, 'README.md'), '# demo\n', 'utf8')
  await git(origin, ['add', '-A'])
  await git(origin, ['commit', '-qm', 'init'])
  await git(origin, ['branch', '-M', 'main'])
  return origin
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('project mirror and ticket worktree', () => {
  it('clones a mirror once and creates a ticket worktree from main', async () => {
    const origin = await makeOrigin()
    const root = await mkdtemp(join(tmpdir(), 'sa-mirror-'))
    roots.push(root)
    const mirror = join(root, 'project.git')
    const worktree = join(root, 'ticket')

    await ensureMirror({ remoteUrl: origin, mirrorDir: mirror })
    await createTicketWorktree({
      mirrorDir: mirror,
      worktreeDir: worktree,
      branch: 'agent/t-test01',
      baseRef: 'main',
    })

    expect(await readFile(join(worktree, 'README.md'), 'utf8')).toBe('# demo\n')
    await git(worktree, ['config', 'user.name', 'Test'])
    await git(worktree, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(worktree, 'new.txt'), 'hello\n', 'utf8')
    await git(worktree, ['add', '-A'])
    await git(worktree, ['commit', '-qm', 'change'])
    expect(await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toContain('agent/t-test01')
  })

  it('reports dirty worktrees and removes clean or forced worktrees', async () => {
    const origin = await makeOrigin()
    const root = await mkdtemp(join(tmpdir(), 'sa-mirror-'))
    roots.push(root)
    const mirror = join(root, 'project.git')
    await ensureMirror({ remoteUrl: origin, mirrorDir: mirror })

    const dirty = join(root, 'dirty')
    await createTicketWorktree({ mirrorDir: mirror, worktreeDir: dirty, branch: 'agent/dirty', baseRef: 'main' })
    await writeFile(join(dirty, 'dirty.txt'), 'x', 'utf8')
    expect(await removeTicketWorktree({ mirrorDir: mirror, worktreeDir: dirty })).toBe('dirty')
    expect(await removeTicketWorktree({ mirrorDir: mirror, worktreeDir: dirty, force: true })).toBe('removed')

    const clean = join(root, 'clean')
    await createTicketWorktree({ mirrorDir: mirror, worktreeDir: clean, branch: 'agent/clean', baseRef: 'main' })
    expect(await removeTicketWorktree({ mirrorDir: mirror, worktreeDir: clean })).toBe('removed')
    expect(await removeTicketWorktree({ mirrorDir: mirror, worktreeDir: clean })).toBe('missing')
  })
})
