import { and, desc, eq, gte, lte } from 'drizzle-orm'
import type { Deps } from './deps.js'
import { auditLogs } from '../db/schema.js'

export interface AuditInput {
  projectId?: string | null
  actorId?: string | null
  actorLabel?: string | null
  action: string
  target?: string | null
  metadata?: Record<string, unknown>
}

/** Audit is best effort only for the write itself; a failed audit write is logged. */
export async function audit(deps: Deps, input: AuditInput): Promise<void> {
  try {
    await deps.db.insert(auditLogs).values({
      projectId: input.projectId ?? null,
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel ?? null,
      action: input.action,
      target: input.target ?? null,
      metadata: input.metadata ?? null,
      createdAt: deps.now(),
    })
  } catch (error) {
    deps.log.error({ err: error, action: input.action }, 'failed to write audit log')
  }
}

export interface AuditQuery {
  projectId: string
  action?: string
  from?: Date
  to?: Date
  limit?: number
  offset?: number
}

export async function listAudit(deps: Deps, query: AuditQuery) {
  const filters = [eq(auditLogs.projectId, query.projectId)]
  if (query.action) filters.push(eq(auditLogs.action, query.action))
  if (query.from) filters.push(gte(auditLogs.createdAt, query.from))
  if (query.to) filters.push(lte(auditLogs.createdAt, query.to))
  return deps.db
    .select()
    .from(auditLogs)
    .where(and(...filters))
    .orderBy(desc(auditLogs.id))
    .limit(Math.min(query.limit ?? 50, 200))
    .offset(query.offset ?? 0)
}
