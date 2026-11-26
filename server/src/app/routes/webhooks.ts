import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { forgetDelivery, ingestInboundEvent, registerDelivery } from '../../services/intake.js'
import { handleGithubWebhook } from '../../services/github-webhooks.js'
import { decideActionApproval } from '../../services/approvals.js'
import { buildFeishuInteractiveCard } from '../../im/feishu.js'
import { constantTimeEqual } from '../../security/tokens.js'
import { identities, users } from '../../db/schema.js'
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

  /** Feishu interactive card button callback (approve / reject directly from chat). */
  app.post('/webhooks/feishu/card', { config: limitConfig }, async (request) => {
    const payload = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>
    if (ctx.config.FEISHU_VERIFICATION_TOKEN) {
      const token = typeof payload.token === 'string' ? payload.token : ''
      if (!token || !constantTimeEqual(token, ctx.config.FEISHU_VERIFICATION_TOKEN)) {
        throw unauthorized('飞书卡片回调 token 无效')
      }
    }
    if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
      return { challenge: payload.challenge }
    }
    const openId = typeof payload.open_id === 'string' ? payload.open_id : ''
    const action = (payload.action && typeof payload.action === 'object' ? payload.action : {}) as Record<string, unknown>
    const value = (action.value && typeof action.value === 'object' ? action.value : {}) as Record<string, unknown>
    if (value.action !== 'approval' || typeof value.projectId !== 'string' || typeof value.approvalId !== 'string') {
      return { toast: { type: 'info', content: '未识别的卡片动作' } }
    }
    const decision = value.decision === 'approved' ? 'approved' : value.decision === 'rejected' ? 'rejected' : null
    if (!decision) return { toast: { type: 'error', content: '非法审批动作' } }

    const [identity] = await ctx.db
      .select({ user: users })
      .from(identities)
      .innerJoin(users, eq(users.id, identities.userId))
      .where(and(eq(identities.provider, 'feishu'), eq(identities.externalId, openId)))
    if (!identity) {
      return { toast: { type: 'error', content: '请先使用飞书登录 Superagent 控制台关联身份' } }
    }

    const result = await decideActionApproval(ctx, value.projectId, value.approvalId, identity.user, { decision })
    return buildFeishuInteractiveCard({
      title: `${result.approval.title}（${decision === 'approved' ? '已批准' : '已拒绝'}）`,
      body: `已由 **${identity.user.name}** 处理，Bot 正在从断点继续执行。`,
      status: decision,
      url: `${ctx.config.PUBLIC_BASE_URL}/projects/${value.projectId}?tab=inbox`,
    })
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
