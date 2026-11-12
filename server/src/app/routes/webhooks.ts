import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { forgetDelivery, ingestInboundEvent, registerDelivery } from '../../services/intake.js'
import { handleGithubWebhook } from '../../services/github-webhooks.js'
import { verifyGithubSignature } from '../../github/verify.js'
import { audit } from '../../services/audit.js'
import { AppError, badRequest, unauthorized } from '../../errors.js'

type Query = Record<string, string | string[] | undefined>

export function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext): void {
  const limitConfig = { rateLimit: { max: ctx.config.RATE_LIMIT_WEBHOOK_MAX, timeWindow: '1 minute' } }

  app.post('/webhooks/feishu', { config: limitConfig }, async (request, reply) => {
    const adapter = ctx.im.feishu
    if (!adapter) throw new AppError(404, 'not_found', '飞书回调未启用')
    const result = await adapter.verifyAndParse({
      headers: request.headers,
      rawBody: request.rawBody ?? Buffer.alloc(0),
      query: request.query as Query,
    })
    if (result.challenge) return { challenge: result.challenge }
    let processed = 0
    for (const event of result.events) {
      if (!(await registerDelivery(ctx, 'feishu', event.deliveryId, event.eventType))) continue
      try {
        const outcomes = await ingestInboundEvent(ctx, event)
        processed += outcomes.length
        await audit(ctx, {
          action: 'webhook.feishu',
          metadata: {
            eventId: event.deliveryId,
            eventType: event.eventType,
            outcomes: outcomes.map((outcome) => ({ action: outcome.action, reason: outcome.reason ?? null })),
          },
        })
      } catch (error) {
        await forgetDelivery(ctx, 'feishu', event.deliveryId)
        throw error
      }
    }
    reply.code(200)
    return { code: 0, processed }
  })

  app.get('/webhooks/wecom', { config: limitConfig }, async (request, reply) => {
    const adapter = ctx.im.wecom
    if (!adapter) throw new AppError(404, 'not_found', '企业微信回调未启用')
    const result = await adapter.verifyAndParse({
      headers: request.headers,
      rawBody: Buffer.alloc(0),
      query: request.query as Query,
    })
    if (!result.challenge) throw badRequest('缺少 echostr')
    reply.type('text/plain; charset=utf-8')
    return result.challenge
  })

  app.post('/webhooks/wecom', { config: limitConfig }, async (request, reply) => {
    const adapter = ctx.im.wecom
    if (!adapter) throw new AppError(404, 'not_found', '企业微信回调未启用')
    const result = await adapter.verifyAndParse({
      headers: request.headers,
      rawBody: request.rawBody ?? Buffer.from(String(request.body ?? '')),
      query: request.query as Query,
    })
    if (result.challenge) {
      reply.type('text/plain; charset=utf-8')
      return result.challenge
    }
    for (const event of result.events) {
      if (!(await registerDelivery(ctx, 'wecom', event.deliveryId, event.eventType))) continue
      try {
        await ingestInboundEvent(ctx, event)
        await audit(ctx, { action: 'webhook.wecom', metadata: { eventId: event.deliveryId, eventType: event.eventType } })
      } catch (error) {
        await forgetDelivery(ctx, 'wecom', event.deliveryId)
        throw error
      }
    }
    reply.type('text/plain; charset=utf-8')
    return ''
  })

  app.post('/webhooks/github', { config: limitConfig }, async (request, reply) => {
    const secret = ctx.config.GITHUB_WEBHOOK_SECRET
    if (!secret) throw new AppError(503, 'internal', 'GITHUB_WEBHOOK_SECRET 未配置')
    const raw = request.rawBody ?? Buffer.from('')
    if (!verifyGithubSignature(secret, raw, request.headers['x-hub-signature-256'] as string | undefined)) {
      throw unauthorized('GitHub webhook 签名校验失败')
    }
    const delivery = request.headers['x-github-delivery'] as string | undefined
    const event = (request.headers['x-github-event'] as string | undefined) ?? 'unknown'
    if (!delivery) throw badRequest('缺少 X-GitHub-Delivery')
    if (!(await registerDelivery(ctx, 'github', delivery, event))) {
      return reply.code(202).send({ ok: true, duplicate: true })
    }
    const payload = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>
    try {
      const result = await handleGithubWebhook(ctx, event, payload, delivery)
      reply.code(202)
      return { ok: true, handled: result.handled }
    } catch (error) {
      await forgetDelivery(ctx, 'github', delivery)
      throw error
    }
  })
}
