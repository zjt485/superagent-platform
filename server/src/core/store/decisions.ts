import { asc, eq } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import { decisions, type DecisionRow } from '../../db/schema.js'
import type { DecisionAction } from '../domain/types.js'

export interface NewDecision {
  id: string
  projectId: string
  runId: string
  triggerId: string
  threadKey?: string | null
  action: DecisionAction
  ticketId?: string | null
  title?: string | null
  reason: string
  confidence?: number | null
  payload?: Record<string, unknown> | null
  decidedAt: Date
}

/** Insert per-trigger decisions; a replay of the same trigger is ignored. */
export async function insertDecisions(db: Database, rows: NewDecision[]): Promise<number> {
  if (rows.length === 0) return 0
  const inserted = await db
    .insert(decisions)
    .values(
      rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        runId: row.runId,
        triggerId: row.triggerId,
        threadKey: row.threadKey ?? null,
        action: row.action,
        ticketId: row.ticketId ?? null,
        title: row.title ?? null,
        reason: row.reason,
        confidence: row.confidence ?? null,
        payload: row.payload ?? null,
        decidedAt: row.decidedAt,
      })),
    )
    .onConflictDoNothing({ target: decisions.triggerId })
    .returning({ id: decisions.id })
  return inserted.length
}

export async function listDecisionsByRun(db: Database, runId: string): Promise<DecisionRow[]> {
  return db
    .select()
    .from(decisions)
    .where(eq(decisions.runId, runId))
    .orderBy(asc(decisions.decidedAt))
}
