import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { newId } from '../src/domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY } from '../src/domain/policy.js'
import { openTestDatabase } from './helpers/db.js'
import type { DatabaseHandle } from '../src/db/client.js'
import { projects, users } from '../src/db/schema.js'

let handle: DatabaseHandle | undefined

afterEach(async () => {
  await handle?.close()
  handle = undefined
})

describe('database foundation', () => {
  it('applies migrations and round-trips rows on PGlite', async () => {
    handle = await openTestDatabase()
    const userId = newId()
    await handle.db.insert(users).values({ id: userId, name: 'Owner' })
    const projectId = newId()
    await handle.db.insert(projects).values({
      id: projectId,
      name: 'Demo',
      slug: 'demo',
      ownerId: userId,
      status: 'draft',
      policyJson: DEFAULT_POLICY,
      modelConfig: DEFAULT_MODEL_CONFIG,
    })

    const rows = await handle.db.select().from(projects).where(eq(projects.id, projectId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.policyJson.maxConcurrentRuns).toBe(1)
    expect(rows[0]?.status).toBe('draft')
  })
})
