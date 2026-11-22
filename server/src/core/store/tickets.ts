import { and, desc, eq, ne } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import { tickets, type TicketRow } from '../../db/schema.js'
import type { TicketStage } from '../domain/types.js'
import { statusOfStage } from '../domain/stage.js'

export interface NewTicket {
  id: string
  projectId: string
  channelId: string | null
  threadKey: string
  requesterId?: string | null
  requesterName?: string | null
  title: string
  body: string
  shortName: string
  stage: TicketStage
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  branch?: string | null
  baseRef?: string | null
  policyVersion?: string | null
  originTriggerId?: string | null
  at: Date
}

export async function insertTicket(db: Database, input: NewTicket): Promise<TicketRow> {
  const [row] = await db
    .insert(tickets)
    .values({
      id: input.id,
      projectId: input.projectId,
      channelId: input.channelId,
      threadKey: input.threadKey,
      requesterId: input.requesterId ?? null,
      requesterName: input.requesterName ?? null,
      title: input.title,
      body: input.body,
      shortName: input.shortName,
      stage: input.stage,
      status: statusOfStage(input.stage),
      priority: input.priority ?? 'normal',
      branch: input.branch ?? null,
      baseRef: input.baseRef ?? null,
      policyVersion: input.policyVersion ?? null,
      originTriggerId: input.originTriggerId ?? null,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .returning()
  if (row === undefined) throw new Error('insertTicket returned no row')
  return row
}

export async function getTicket(db: Database, id: string): Promise<TicketRow | undefined> {
  const [row] = await db.select().from(tickets).where(eq(tickets.id, id))
  return row
}

export async function getTicketByShortName(
  db: Database,
  projectId: string,
  shortName: string,
): Promise<TicketRow | undefined> {
  const [row] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), eq(tickets.shortName, shortName)))
  return row
}

/** Tickets that are not done/cancelled, newest first. */
export async function listLiveTickets(db: Database, projectId: string): Promise<TicketRow[]> {
  return db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), ne(tickets.stage, 'done'), ne(tickets.stage, 'cancelled')))
    .orderBy(desc(tickets.updatedAt))
}

export async function setTicketStage(
  db: Database,
  id: string,
  stage: TicketStage,
  at: Date,
): Promise<TicketRow | undefined> {
  const terminal = stage === 'done' || stage === 'cancelled'
  const [row] = await db
    .update(tickets)
    .set({
      stage,
      status: statusOfStage(stage),
      updatedAt: at,
      endedAt: terminal ? at : null,
      closedAt: terminal ? at : null,
    })
    .where(eq(tickets.id, id))
    .returning()
  return row
}

export async function setTicketDelivery(
  db: Database,
  id: string,
  input: { branch: string | null; prUrl: string | null; at: Date },
): Promise<void> {
  await db
    .update(tickets)
    .set({ branch: input.branch, prUrl: input.prUrl, updatedAt: input.at })
    .where(eq(tickets.id, id))
}

export async function setTicketWorktree(
  db: Database,
  id: string,
  input: { branch: string; worktreePath: string | null; baseRef: string | null; at: Date },
): Promise<void> {
  await db
    .update(tickets)
    .set({
      branch: input.branch,
      worktreePath: input.worktreePath,
      baseRef: input.baseRef,
      updatedAt: input.at,
    })
    .where(eq(tickets.id, id))
}
