import { and, eq } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import { agentSessions } from '../../db/schema.js'
import { newId } from '../../domain/ids.js'

/** Ensure the one Executor Session row for a ticket exists and return its id. */
export async function ensureExecutorSession(
  db: Database,
  projectId: string,
  ticketId: string,
  at: Date,
): Promise<string> {
  const [existing] = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.ticketId, ticketId), eq(agentSessions.role, 'executor')))
  if (existing !== undefined) return existing.id
  const id = newId()
  await db
    .insert(agentSessions)
    .values({
      id,
      projectId,
      role: 'executor',
      ticketId,
      status: 'idle',
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing()
  const [row] = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.ticketId, ticketId), eq(agentSessions.role, 'executor')))
  if (row === undefined) throw new Error(`could not create executor session for ${ticketId}`)
  return row.id
}
