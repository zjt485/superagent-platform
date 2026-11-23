import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { api, cookieOf, createHarness, testConfig } from '../helpers/app.js'
import { projects, repos } from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'
import { insertTicket } from '../../src/core/store/tickets.js'
import { GitDeliveryProvider } from '../../src/core/worker/delivery.js'
import { FakeGitOps } from '../../src/worker/fake-git.js'
import { MockGithubClient } from '../../src/github/client.js'

const run = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sa-local-repo-'))
  roots.push(root)
  await run('git', ['init', '-q'], { cwd: root, windowsHide: true })
  await run('git', ['config', 'user.name', 'Test'], { cwd: root, windowsHide: true })
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root, windowsHide: true })
  await writeFile(join(root, 'README.md'), '# local\n', 'utf8')
  await run('git', ['add', '-A'], { cwd: root, windowsHide: true })
  await run('git', ['commit', '-qm', 'init'], { cwd: root, windowsHide: true })
  return root
}

describe('local repository mode', () => {
  it('binds a local git directory and commits without pushing or opening a PR', async () => {
    const harness = await createHarness()
    const login = await api(harness, 'POST', '/v1/auth/dev-login', { body: { name: 'Alice' } })
    const cookie = cookieOf(login)
    const project = await api(harness, 'POST', '/v1/projects', { cookie, body: { name: 'Local' } })
    const projectId = project.json.project.id as string
    const localPath = await makeRepo()

    const bound = await api(harness, 'POST', `/v1/projects/${projectId}/local-repo`, {
      cookie,
      body: { path: localPath, defaultBranch: 'master' },
    })
    expect(bound.status).toBe(200)
    expect(bound.json.repo.provider).toBe('local')
    expect(bound.json.repo.fullName).toBe(localPath)

    const [projectRow] = await harness.ctx.db.select().from(projects).where(eq(projects.id, projectId))
    if (projectRow === undefined) throw new Error('missing project')
    const ticket = await insertTicket(harness.ctx.db, {
      id: newId(),
      projectId,
      channelId: null,
      threadKey: 'thread-local',
      title: 'Local change',
      body: 'details',
      shortName: 't-local1',
      stage: 'review',
      at: new Date('2026-11-23T00:00:00Z'),
    })
    const git = new FakeGitOps()
    const delivery = new GitDeliveryProvider({
      db: harness.ctx.db,
      git,
      github: new MockGithubClient(testConfig()),
      author: { name: 'Test', email: 'test@example.com' },
    })
    const result = await delivery.deliver({
      project: projectRow,
      ticket,
      report: { status: 'ready', summary: 'done', changedFiles: ['README.md'] },
      worktreePath: localPath,
      at: new Date('2026-11-23T00:01:00Z'),
    })
    expect(result.committed).toBe(true)
    expect(result.prUrl).toBeNull()
    expect(git.committed).toHaveLength(1)
    expect(git.pushed).toHaveLength(0)
    await harness.close()
  })

  it('rejects a non-git directory', async () => {
    const harness = await createHarness()
    const login = await api(harness, 'POST', '/v1/auth/dev-login', { body: { name: 'Bob' } })
    const cookie = cookieOf(login)
    const project = await api(harness, 'POST', '/v1/projects', { cookie, body: { name: 'Bad' } })
    const projectId = project.json.project.id as string
    const root = await mkdtemp(join(tmpdir(), 'sa-not-git-'))
    roots.push(root)
    const response = await api(harness, 'POST', `/v1/projects/${projectId}/local-repo`, {
      cookie,
      body: { path: root },
    })
    expect(response.status).toBe(400)
    await harness.close()
  })
})
