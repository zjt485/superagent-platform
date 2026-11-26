import { and, asc, eq, max } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import { sessionTurns, type TurnRow } from '../../db/schema.js'
import type { TurnStatus } from '../domain/types.js'

export interface NewTurn {
  id: string
  projectId: string
  sessionId: string
  ticketId: string
  botId?: string | null
  kind?: 'eval' | 'execute' | 'resume'
  seq: number
  inputIds: string[]
  model?: string | null
  at: Date
}

export async function nextTurnSeq(db: Database, ticketId: string): Promise<number> {
  const [row] = await db
    .select({ value: max(sessionTurns.seq) })
    .from(sessionTurns)
    .where(eq(sessionTurns.ticketId, ticketId))
  return (row?.value ?? 0) + 1
}

export async function insertTurn(db: Database, input: NewTurn): Promise<TurnRow> {
  const [row] = await db
    .insert(sessionTurns)
    .values({
      id: input.id,
      projectId: input.projectId,
      sessionId: input.sessionId,
      ticketId: input.ticketId,
      botId: input.botId ?? null,
      kind: input.kind ?? 'execute',
      status: 'queued',
      seq: input.seq,
      input: { inputIds: input.inputIds },
      model: input.model ?? null,
      createdAt: input.at,
    })
    .returning()
  if (row === undefined) throw new Error('insertTurn returned no row')
  return row
}

export async function getTurn(db: Database, id: string): Promise<TurnRow | undefined> {
  const [row] = await db.select().from(sessionTurns).where(eq(sessionTurns.id, id))
  return row
}

export interface FinishTurnInput {
  status: TurnStatus
  result?: unknown
  error?: string | null
  tokens?: number
  cost?: number
  exitCode?: number | null
  at: Date
}

export async function finishTurn(
  db: Database,
  id: string,
  input: FinishTurnInput,
): Promise<TurnRow | undefined> {
  const [row] = await db
    .update(sessionTurns)
    .set({
      status: input.status,
      result: input.result ?? null,
      error: input.error ?? null,
      tokens: input.tokens ?? 0,
      cost: input.cost ?? 0,
      exitCode: input.exitCode ?? null,
      endedAt: input.at,
      heartbeatAt: input.at,
    })
    .where(eq(sessionTurns.id, id))
    .returning()
  return row
}

export async function listTurns(db: Database, ticketId: string): Promise<TurnRow[]> {
  return db
    .select()
    .from(sessionTurns)
    .where(and(eq(sessionTurns.ticketId, ticketId), eq(sessionTurns.kind, 'execute')))
    .orderBy(asc(sessionTurns.seq))
}
