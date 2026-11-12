import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { uuidParam } from '../../http/helpers.js'
import { findTurn, recordTurnEvent } from '../../dual/sessions.js'
import { sessionTurns } from '../../db/schema.js'
import { eq } from 'drizzle-orm'
import { constantTimeEqual } from '../../security/tokens.js'
import { unauthorized } from '../../errors.js'

const eventSchema = z.object({
  type: z.string().min(1).max(80),
  message: z.string().max(4000).optional(),
  payload: z.unknown().optional(),
})

function checkToken(token: string | undefined, expected: string): void {
  const value = token?.startsWith('Bearer ') ? token.slice(7) : ''
  if (!value || !constantTimeEqual(value, expected)) throw unauthorized('内部服务 token 无效')
}

export function registerInternalRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/internal/runs/:id/events', async (request, reply) => {
    checkToken(request.headers.authorization, ctx.config.INTERNAL_TOKEN)
    const runId = uuidParam(request)
    const parsed = eventSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: '事件格式不合法' } })
    }
    const turn = await findTurn(ctx, runId)
    await recordTurnEvent(ctx, turn, {
      type: parsed.data.type,
      message: parsed.data.message ?? null,
      payload: parsed.data.payload ?? null,
    })
    return { ok: true }
  })

  app.post('/internal/runs/:id/heartbeat', async (request) => {
    checkToken(request.headers.authorization, ctx.config.INTERNAL_TOKEN)
    await ctx.db.update(sessionTurns).set({ heartbeatAt: ctx.now() }).where(eq(sessionTurns.id, uuidParam(request)))
    return { ok: true }
  })
}
