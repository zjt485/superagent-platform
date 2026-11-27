import { z } from 'zod'

import type { RouterOutput } from '../domain/types.js'

const optionalNonEmptyString = z.preprocess(
  (value) => {
    if (value === null || value === undefined) return undefined
    if (typeof value === 'string') {
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }
    return value
  },
  z.string().min(1).optional(),
)

const optionalBotSlug = z.preprocess(
  (value) => {
    if (value === null || value === undefined) return undefined
    if (typeof value === 'string') {
      const trimmed = value.trim().replace(/^[@＠]+/, '')
      return trimmed.length > 0 ? trimmed : undefined
    }
    return value
  },
  z.string().min(1).optional(),
)

const optionalString = z.preprocess((value) => (value === null ? undefined : value), z.string().optional())

const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (value) => (value === null || value === undefined || (typeof value === 'string' && value.trim() === '') ? undefined : value),
    z.enum(values).optional(),
  )

const optionalConfidence = z.preprocess((value) => (value === null || value === '' ? undefined : value), z.number().min(0).max(1).optional())

const optionalPayload = z.preprocess(
  (value) => (value === null || value === undefined ? undefined : value),
  z.record(z.string(), z.unknown()).optional(),
)

const decisionItemSchema = z.object({
  triggerId: z.string().min(1),
  action: z.enum(['new', 'attach', 'ignore', 'stop', 'command']),
  ticketId: optionalNonEmptyString,
  botSlug: optionalBotSlug,
  botId: optionalNonEmptyString,
  title: optionalNonEmptyString,
  body: optionalString,
  scope: optionalString,
  planApproval: optionalEnum(['required', 'auto'] as const),
  priority: optionalEnum(['low', 'normal', 'high', 'urgent'] as const),
  reason: z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'router decision'),
    z.string().min(1),
  ),
  confidence: optionalConfidence,
  payload: optionalPayload,
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
    const issueSummary = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ')
    throw new RouterOutputError(`invalid router output (${issueSummary})`, parsed.error)
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
