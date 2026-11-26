import { z } from 'zod'

import type { RouterOutput } from '../domain/types.js'

const decisionItemSchema = z.object({
  triggerId: z.string().min(1),
  action: z.enum(['new', 'attach', 'ignore', 'stop', 'command']),
  ticketId: z.string().min(1).optional(),
  botSlug: z.string().min(1).optional(),
  botId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  scope: z.string().optional(),
  planApproval: z.enum(['required', 'auto']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
})

const routerOutputSchema = z.object({
  summary: z.string(),
  items: z.array(decisionItemSchema),
})

export class RouterOutputError extends Error {
  readonly details: unknown

  constructor(message: string, details?: unknown) {
    super(message)
    this.name = 'RouterOutputError'
    this.details = details
  }
}

function assertActionShape(item: z.infer<typeof decisionItemSchema>): void {
  if (item.action === 'new' && item.title === undefined) {
    throw new RouterOutputError(`decision for ${item.triggerId}: new requires a title`)
  }
  if ((item.action === 'attach' || item.action === 'stop') && item.ticketId === undefined) {
    throw new RouterOutputError(`decision for ${item.triggerId}: ${item.action} requires a ticketId`)
  }
}

/** Parse and validate the Router model's JSON output. */
export function parseRouterOutput(raw: unknown): RouterOutput {
  const parsed = routerOutputSchema.safeParse(raw)
  if (!parsed.success) {
    throw new RouterOutputError('invalid router output', parsed.error)
  }
  const seen = new Set<string>()
  for (const item of parsed.data.items) {
    assertActionShape(item)
    if (seen.has(item.triggerId)) {
      throw new RouterOutputError(`duplicate decision for ${item.triggerId}`)
    }
    seen.add(item.triggerId)
  }
  return parsed.data as RouterOutput
}

/** Ensure the model covered the batch exactly once and invented no triggers. */
export function validateRouterOutput(output: RouterOutput, batchTriggerIds: string[]): void {
  const batch = new Set(batchTriggerIds)
  const seen = new Set<string>()
  for (const item of output.items) {
    if (!batch.has(item.triggerId)) {
      throw new RouterOutputError(`decision for trigger outside the batch: ${item.triggerId}`)
    }
    if (seen.has(item.triggerId)) {
      throw new RouterOutputError(`duplicate decision for ${item.triggerId}`)
    }
    seen.add(item.triggerId)
  }
  for (const triggerId of batchTriggerIds) {
    if (!seen.has(triggerId)) {
      throw new RouterOutputError(`missing decision for ${triggerId}`)
    }
  }
}
