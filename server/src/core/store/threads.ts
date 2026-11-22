import { and, asc, eq, isNull, lt, or } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import { threads, type ThreadRow } from '../../db/schema.js'
import { newId } from '../../domain/ids.js'

export interface ThreadScope {
  projectId: string
  channelId: string | null
  threadKey: string
}

export interface TouchThreadInput extends ThreadScope {
  at: Date
}

/** Create the thread on first use and refresh last_trigger_at afterwards. */
export async function touchThread(db: Database, input: TouchThreadInput): Promise<void> {
  const now = input.at
  await db
    .insert(threads)
    .values({
      id: newId(),
      projectId: input.projectId,
      channelId: input.channelId,
      threadKey: input.threadKey,
      lastTriggerAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [threads.projectId, threads.channelId, threads.threadKey],
      set: { lastTriggerAt: now, updatedAt: now },
    })
}

export async function getThread(db: Database, scope: ThreadScope): Promise<ThreadRow | undefined> {
  const [row] = await db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.projectId, scope.projectId),
        scope.channelId === null ? isNull(threads.channelId) : eq(threads.channelId, scope.channelId),
        eq(threads.threadKey, scope.threadKey),
      ),
    )
  return row
}

/** Mark a thread as having pending triggers; the worker will claim it. */
export async function markThreadPending(db: Database, scope: ThreadScope, at: Date): Promise<void> {
  await db
    .update(threads)
    .set({ routerPending: true, updatedAt: at })
    .where(
      and(
        eq(threads.projectId, scope.projectId),
        scope.channelId === null ? isNull(threads.channelId) : eq(threads.channelId, scope.channelId),
        eq(threads.threadKey, scope.threadKey),
      ),
    )
}

/**
 * Claim one pending thread whose lease is absent or expired. The row lock is
 * held only for the claim transaction, not while the model runs.
 */
export async function claimPendingThread(
  db: Database,
  now: Date,
  leaseMs: number,
): Promise<ThreadRow | undefined> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(threads)
      .where(
        and(
          eq(threads.routerPending, true),
          or(isNull(threads.routerLeaseUntil), lt(threads.routerLeaseUntil, now)),
        ),
      )
      .orderBy(asc(threads.lastTriggerAt))
      .limit(1)
      .for('update', { skipLocked: true })
    if (candidate === undefined) return undefined
    const [claimed] = await tx
      .update(threads)
      .set({ routerLeaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now })
      .where(eq(threads.id, candidate.id))
      .returning()
    return claimed
  })
}

/** Clear pending + lease after a Router flush (or on failure). */
export async function releaseThread(
  db: Database,
  id: string,
  summary?: string,
): Promise<void> {
  await db
    .update(threads)
    .set({
      routerPending: false,
      routerLeaseUntil: null,
      updatedAt: new Date(),
      ...(summary === undefined ? {} : { summary }),
    })
    .where(eq(threads.id, id))
}

/** Drop the lease but keep the thread pending so a later tick can retry. */
export async function releaseThreadLease(db: Database, id: string): Promise<void> {
  await db
    .update(threads)
    .set({ routerLeaseUntil: null, updatedAt: new Date() })
    .where(eq(threads.id, id))
}

export async function setThreadSummary(db: Database, id: string, summary: string): Promise<void> {
  await db.update(threads).set({ summary, updatedAt: new Date() }).where(eq(threads.id, id))
}
