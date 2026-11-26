import { existsSync } from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { ZodError } from 'zod'
import type { AppContext } from './context.js'
import { AppError, errorBody, rateLimited } from '../errors.js'
import { userBySession } from '../services/auth.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerInviteRoutes } from './routes/invites.js'
import { registerJoinRoutes } from './routes/join.js'
import { registerRepoRoutes } from './routes/repo.js'
import { registerChannelRoutes } from './routes/channels.js'
import { registerTicketRoutes } from './routes/tickets.js'
import { registerWebhookRoutes } from './routes/webhooks.js'
import { registerInternalRoutes } from './routes/internal.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerBotRoutes } from './routes/bots.js'
import { registerRoomRoutes } from './routes/rooms.js'

const SPA_PREFIXES = ['/v1', '/webhooks', '/internal', '/healthz', '/readyz', '/metrics']

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log as unknown as FastifyBaseLogger,
    trustProxy: ctx.config.TRUST_PROXY,
    bodyLimit: 4 * 1024 * 1024,
    // Signed join/invite tokens are longer than Fastify's default 100 chars.
    routerOptions: { maxParamLength: 2048 },
  })

  app.decorateRequest('user', null)
  app.decorateRequest('rawBody', null)

  await app.register(cookie)
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    allowList: [],
  })

  // Keep the raw payload for webhook signatures while still handing routes a
  // parsed JSON object.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    request.rawBody = raw
    try {
      const text = raw.toString('utf8')
      done(null, text ? JSON.parse(text) : {})
    } catch (error) {
      done(error as Error)
    }
  })
  app.addContentTypeParser(['text/xml', 'application/xml'], { parseAs: 'buffer' }, (request, body, done) => {
    const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    request.rawBody = raw
    done(null, raw.toString('utf8'))
  })

  app.addHook('onRequest', async (request) => {
    const token = request.cookies?.sa_session
    if (token) {
      request.user = await userBySession(ctx, token)
    }
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    if (unsafe && request.url.startsWith('/v1/') && request.cookies?.sa_session) {
      const header = request.headers['x-superagent-csrf']
      let sameOrigin = false
      const origin = request.headers.origin
      if (origin) {
        try {
          sameOrigin = new URL(origin).host === request.headers.host
        } catch {
          sameOrigin = false
        }
      }
      if (header !== '1' && !sameOrigin) throw new AppError(403, 'forbidden', 'CSRF 校验失败，请刷新页面重试')
    }
  })

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'no-referrer')
    return payload
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send(errorBody(error))
      return
    }
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: {
          code: 'bad_request',
          message: '请求参数不合法',
          details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      })
      return
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      reply.code(429).send(errorBody(rateLimited()))
      return
    }
    request.log.error({ err: error }, 'unhandled request error')
    reply.code(500).send({ error: { code: 'internal', message: '服务器内部错误' } })
  })

  registerHealthRoutes(app, ctx)
  registerAuthRoutes(app, ctx)
  registerProjectRoutes(app, ctx)
  registerInviteRoutes(app, ctx)
  registerJoinRoutes(app, ctx)
  registerRepoRoutes(app, ctx)
  registerChannelRoutes(app, ctx)
  registerTicketRoutes(app, ctx)
  registerBotRoutes(app, ctx)
  registerRoomRoutes(app, ctx)
  registerWebhookRoutes(app, ctx)
  registerInternalRoutes(app, ctx)

  const distDir = path.resolve(process.cwd(), ctx.config.WEB_DIST_DIR)
  const hasWeb = ctx.config.SERVE_WEB && existsSync(path.join(distDir, 'index.html'))
  if (hasWeb) {
    // `@fastify/static` registers the directory index route itself, so `/` is
    // deliberately not declared twice.
    await app.register(fastifyStatic, { root: distDir, wildcard: false, index: ['index.html'] })
  } else {
    app.get('/', async () => ({
      name: ctx.config.APP_NAME,
      version: '0.1.0',
      message: 'Superagent 控制台尚未构建。运行 pnpm --filter @superagent/web build 后重启，或使用 Vite 开发服务器。',
      api: '/v1/session',
    }))
  }

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? request.url
    const isApi = SPA_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
    const looksLikeAsset = /\.[a-zA-Z0-9]{1,8}$/.test(pathname)
    if (!isApi && !looksLikeAsset && hasWeb && request.method === 'GET') {
      return reply.sendFile('index.html')
    }
    return reply.code(404).send({ error: { code: 'not_found', message: '资源不存在' } })
  })

  return app
}
