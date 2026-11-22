import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { openTestDatabase } from '../helpers/db.js'
import { testConfig } from '../helpers/app.js'
import type { DatabaseHandle } from '../../src/db/client.js'
import { projects, repos, users } from '../../src/db/schema.js'
import { newId } from '../../src/domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY } from '../../src/domain/policy.js'
import { insertTicket, getTicket } from '../../src/core/store/tickets.js'
import { GitDeliveryProvider } from '../../src/core/worker/delivery.js'
import { FakeGitOps } from '../../src/worker/fake-git.js'
import { MockGithubClient } from '../../src/github/client.js'

let handle: DatabaseHandle

beforeAll(async () => {
  handle = await openTestDatabase()
})

afterAll(async () => {
  await handle.close()
})

describe('git delivery', () => {
  it('commits the worktree, pushes the branch and opens a PR', async () => {
    const userId = newId()
    const projectId = newId()
    await handle.db.insert(users).values({ id: userId, name: 'Alice' })
    await handle.db.insert(projects).values({
      id: projectId,
      name: 'Demo',
      slug: `demo-${projectId.slice(0, 8)}`,
      ownerId: userId,
      status: 'active',
      policyJson: DEFAULT_POLICY,
      modelConfig: DEFAULT_MODEL_CONFIG,
    })
    await handle.db.insert(repos).values({
      id: newId(),
      projectId,
      installationId: '42',
      owner: 'demo-org',
      name: 'hello-world',
      fullName: 'demo-org/hello-world',
      defaultBranch: 'main',
    })
    const ticket = await insertTicket(handle.db, {
      id: newId(),
      projectId,
      channelId: null,
      threadKey: 'thread-delivery',
      title: 'Fix login',
      body: 'details',
      shortName: 't-deliv1',
      stage: 'review',
      branch: 'agent/t-deliv1',
      at: new Date('2026-11-22T00:00:00Z'),
    })
    const [project] = await handle.db.select().from(projects).where(eq(projects.id, projectId))
    if (project === undefined) throw new Error('missing project')

    const git = new FakeGitOps()
    const provider = new GitDeliveryProvider({
      db: handle.db,
      git,
      github: new MockGithubClient(testConfig()),
      author: { name: 'Test', email: 'test@example.com' },
    })
    const result = await provider.deliver({
      project,
      ticket,
      report: { status: 'ready', summary: 'done', changedFiles: ['src/a.ts'] },
      worktreePath: '/tmp/worktree',
      at: new Date('2026-11-22T00:01:00Z'),
    })

    expect(result.committed).toBe(true)
    expect(result.branch).toBe('agent/t-deliv1')
    expect(result.prUrl).toContain('/pull/')
    expect(git.committed).toHaveLength(1)
    expect(git.pushed).toHaveLength(1)
    expect((await getTicket(handle.db, ticket.id))?.shortName).toBe('t-deliv1')
  })

  it('does not deliver when the project has no repository', async () => {
    const userId = newId()
    const projectId = newId()
    await handle.db.insert(users).values({ id: userId, name: 'Bob' })
    await handle.db.insert(projects).values({
      id: projectId,
      name: 'No repo',
      slug: `no-repo-${projectId.slice(0, 8)}`,
      ownerId: userId,
      status: 'active',
      policyJson: DEFAULT_POLICY,
      modelConfig: DEFAULT_MODEL_CONFIG,
    })
    const ticket = await insertTicket(handle.db, {
      id: newId(),
      projectId,
      channelId: null,
      threadKey: 'thread-no-repo',
      title: 'Nothing',
      body: 'details',
      shortName: 't-norepo',
      stage: 'review',
      at: new Date('2026-11-22T00:00:00Z'),
    })
    const [project] = await handle.db.select().from(projects).where(eq(projects.id, projectId))
    if (project === undefined) throw new Error('missing project')
    const git = new FakeGitOps()
    const provider = new GitDeliveryProvider({
      db: handle.db,
      git,
      github: new MockGithubClient(testConfig()),
      author: { name: 'Test', email: 'test@example.com' },
    })
    const result = await provider.deliver({
      project,
      ticket,
      report: { status: 'ready', summary: 'done' },
      worktreePath: '/tmp/worktree',
      at: new Date('2026-11-22T00:01:00Z'),
    })
    expect(result.committed).toBe(false)
    expect(git.committed).toHaveLength(0)
  })
})
