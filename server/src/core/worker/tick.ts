import { eq } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import { projects } from '../../db/schema.js'
import { flushThread } from '../router/flush.js'
import type { RouterModel } from '../router/model.js'
import { claimPendingThread, releaseThread } from '../store/threads.js'

export interface CoreTickOptions {
  db: Database
  model: RouterModel
  now: () => Date
  policyVersion?: string
  leaseMs?: number
  maxThreads?: number
  batchLimit?: number
  recentLimit?: number
  shortName?: () => string
}

export interface CoreTickResult {
  threads: number
  runs: number
  tickets: number
  turns: number
  errors: number
}

/** Run one Router sweep: claim each pending thread and flush its batch. */
export async function coreTick(options: CoreTickOptions): Promise<CoreTickResult> {
  const result: CoreTickResult = { threads: 0, runs: 0, tickets: 0, turns: 0, errors: 0 }
  const maxThreads = options.maxThreads ?? 10

  for (let index = 0; index < maxThreads; index += 1) {
    const at = options.now()
    const thread = await claimPendingThread(options.db, at, options.leaseMs ?? 30_000)
    if (thread === undefined) break
    result.threads += 1

    const [project] = await options.db.select().from(projects).where(eq(projects.id, thread.projectId))
    if (project === undefined) {
      await releaseThread(options.db, thread.id)
      result.errors += 1
      continue
    }

    try {
      const flushed = await flushThread({
        db: options.db,
        project,
        thread,
        model: options.model,
        policyVersion: options.policyVersion ?? 'v1',
        at,
        ...(options.batchLimit === undefined ? {} : { batchLimit: options.batchLimit }),
        ...(options.recentLimit === undefined ? {} : { recentLimit: options.recentLimit }),
        ...(options.shortName === undefined ? {} : { shortName: options.shortName }),
      })
      if (flushed.runId !== null) result.runs += 1
      result.tickets += flushed.ticketIds.length
      result.turns += flushed.turnIds.length
    } catch {
      // flushThread already marked the batch pending_review and released the thread.
      result.errors += 1
    }
  }

  return result
}
