import { and, desc, eq, sql } from 'drizzle-orm'
import type { Deps } from './deps.js'
import { usage } from '../db/schema.js'
import { newId } from '../domain/ids.js'

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Adds one finished run to today's usage; called exactly once per terminal run. */
export async function recordUsage(deps: Deps, projectId: string, tokens: number, cost: number): Promise<void> {
  const day = dayKey(deps.now())
  await deps.db
    .insert(usage)
    .values({ id: newId(), projectId, day, runs: 1, tokens, cost })
    .onConflictDoUpdate({
      target: [usage.projectId, usage.day],
      set: {
        runs: sql`${usage.runs} + 1`,
        tokens: sql`${usage.tokens} + ${tokens}`,
        cost: sql`${usage.cost} + ${cost}`,
      },
    })
}

export async function tokensUsedToday(deps: Deps, projectId: string): Promise<number> {
  const [row] = await deps.db
    .select({ tokens: usage.tokens })
    .from(usage)
    .where(and(eq(usage.projectId, projectId), eq(usage.day, dayKey(deps.now()))))
  return row?.tokens ?? 0
}

export async function usageSeries(deps: Deps, projectId: string, days = 30) {
  const since = dayKey(new Date(deps.now().getTime() - days * 86_400_000))
  return deps.db.select().from(usage).where(and(eq(usage.projectId, projectId), sql`${usage.day} >= ${since}`)).orderBy(desc(usage.day))
}
