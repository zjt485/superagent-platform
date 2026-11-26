import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { uuidParam } from '../../http/helpers.js'
import { findTurn, recordTurnEvent } from '../../core/operations.js'
import { sessionTurns } from '../../db/schema.js'
import { eq } from 'drizzle-orm'
import { constantTimeEqual } from '../../security/tokens.js'
import { unauthorized } from '../../errors.js'
import { receiveCoreTrigger } from '../../core/intake.js'
import { coreTick } from '../../core/worker/tick.js'
import { routerModelFromConfig } from '../../core/router/from-config.js'

const eventSchema = z.object({
  type: z.string().min(1).max(80),
  message: z.string().max(4000).optional(),
  payload: z.unknown().optional(),
})

const coreTriggerSchema = z.object({
  projectId: z.string().uuid(),
  channelId: z.string().uuid().nullish(),
  provider: z.string().min(1).max(32),
  externalId: z.string().min(1).max(200),
  threadKey: z.string().min(1).max(200),
  actorUserId: z.string().uuid().nullish(),
  actorExternalId: z.string().max(200).nullish(),
  actorName: z.string().max(200).nullish(),
  text: z.string().min(1).max(20_000),
  address: z.enum(['mention', 'direct', 'ambient']).default('mention'),
  isBot: z.boolean().optional(),
  mentionedBot: z.boolean().optional(),
  replyTo: z.string().max(200).nullish(),
  authorized: z.boolean().optional(),
  at: z.string().datetime().optional(),
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

  app.post('/internal/core/triggers', async (request, reply) => {
    checkToken(request.headers.authorization, ctx.config.INTERNAL_TOKEN)
    const parsed = coreTriggerSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: '触发消息格式不合法' } })
    }
    const at = parsed.data.at === undefined ? ctx.now() : new Date(parsed.data.at)
    if (Number.isNaN(at.getTime())) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'at 不是合法时间' } })
    }
    return receiveCoreTrigger(ctx.db, {
      projectId: parsed.data.projectId,
      channelId: parsed.data.channelId ?? null,
      provider: parsed.data.provider,
      externalId: parsed.data.externalId,
      threadKey: parsed.data.threadKey,
      actorUserId: parsed.data.actorUserId ?? null,
      actorExternalId: parsed.data.actorExternalId ?? null,
      actorName: parsed.data.actorName ?? null,
      text: parsed.data.text,
      address: parsed.data.address,
      isBot: parsed.data.isBot,
      mentionedBot: parsed.data.mentionedBot,
      replyTo: parsed.data.replyTo ?? null,
      authorized: parsed.data.authorized,
      at,
    })
  })

  app.post('/internal/core/tick', async (request) => {
    checkToken(request.headers.authorization, ctx.config.INTERNAL_TOKEN)
    return coreTick({
      db: ctx.db,
      model: routerModelFromConfig(ctx.config),
      now: ctx.now,
      maxThreads: 50,
    })
  })
}
