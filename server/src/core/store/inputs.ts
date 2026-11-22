import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

import type { Database } from '../../db/client.js'
import { ticketInputs, type TicketInputRow } from '../../db/schema.js'
import type { InputKind } from '../domain/types.js'

export interface NewTicketInput {
  id: string
  projectId: string
  ticketId: string
  triggerId?: string | null
  source: 'trigger' | 'person' | 'note' | 'policy' | 'approval' | 'system'
  kind?: InputKind
  text: string
  isPerson?: boolean
  at: Date
}

export async function insertTicketInput(db: Database, input: NewTicketInput): Promise<TicketInputRow> {
  const [row] = await db
    .insert(ticketInputs)
    .values({
      id: input.id,
      projectId: input.projectId,
      ticketId: input.ticketId,
      triggerId: input.triggerId ?? null,
      source: input.source,
      kind: input.kind ?? 'message',
      text: input.text,
      isPerson: input.isPerson ?? false,
      createdAt: input.at,
    })
    .returning()
  if (row === undefined) throw new Error('insertTicketInput returned no row')
  return row
}

export async function listUndeliveredInputs(db: Database, ticketId: string): Promise<TicketInputRow[]> {
  return db
    .select()
    .from(ticketInputs)
    .where(and(eq(ticketInputs.ticketId, ticketId), isNull(ticketInputs.deliveredTurnId)))
    .orderBy(asc(ticketInputs.createdAt))
}

export async function markInputsDelivered(
  db: Database,
  ids: string[],
  turnId: string,
  at: Date,
): Promise<void> {
  if (ids.length === 0) return
  await db
    .update(ticketInputs)
    .set({ deliveredTurnId: turnId, deliveredAt: at })
    .where(inArray(ticketInputs.id, ids))
}
