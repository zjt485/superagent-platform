import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import {
  clearOAuthCookie,
  clearSessionCookie,
  parseBody,
  pathParam,
  queryOf,
  setOAuthCookie,
  setSessionCookie,
} from '../../http/helpers.js'
import {
  createOAuthState,
  createSession,
  destroySession,
  devLogin,
  loginWithIdentity,
  readOAuthState,
  safeReturnTo,
} from '../../services/auth.js'
import { AppError, badRequest } from '../../errors.js'

const devLoginSchema = z.object({
  name: z.string().trim().min(1).max(60),
  externalId: z.string().trim().min(1).max(120).optional(),
})

const providerOf = (request: Parameters<typeof pathParam>[0]): 'feishu' | 'wecom' => {
  const provider = pathParam(request, 'provider')
  if (provider !== 'feishu' && provider !== 'wecom') throw new AppError(404, 'not_found', '不支持的登录方式')
  return provider
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/session', async (request) => ({
    user: request.user,
    appName: ctx.config.APP_NAME,
    publicBaseUrl: ctx.config.PUBLIC_BASE_URL,
    auth: {
      devLogin: ctx.config.AUTH_DEV_LOGIN,
      oauth: { feishu: Boolean(ctx.oauth.feishu), wecom: Boolean(ctx.oauth.wecom) },
    },
  }))

  app.post('/v1/auth/dev-login', async (request, reply) => {
    if (!ctx.config.AUTH_DEV_LOGIN) throw new AppError(404, 'not_found', '开发登录未开启')
    const body = parseBody(devLoginSchema, request)
    const session = await devLogin(ctx, body)
    setSessionCookie(ctx.config, reply, session.token, session.expiresAt)
    reply.code(200)
    return { user: session.user }
  })

  app.post('/v1/auth/logout', async (request, reply) => {
    const token = request.cookies?.sa_session
    await destroySession(ctx, token)
    clearSessionCookie(reply)
    return { ok: true }
  })

  app.get('/v1/auth/:provider/start', async (request, reply) => {
    const provider = providerOf(request)
    const oauth = ctx.oauth[provider]
    if (!oauth) throw new AppError(404, 'not_found', `${provider} 登录未配置`)
    const query = queryOf(request)
    const state = createOAuthState(ctx.config, {
      provider,
      returnTo: safeReturnTo(query.returnTo),
      ...(query.invite ? { inviteToken: query.invite } : {}),
    })
    setOAuthCookie(reply, state)
    const redirectUri = `${ctx.config.PUBLIC_BASE_URL}/v1/auth/${provider}/callback`
    const userAgent = typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null
    return reply.redirect(oauth.authorizeUrl({ state, redirectUri, userAgent }))
  })

  app.get('/v1/auth/:provider/callback', async (request, reply) => {
    const provider = providerOf(request)
    const oauth = ctx.oauth[provider]
    if (!oauth) throw new AppError(404, 'not_found', `${provider} 登录未配置`)
    const query = queryOf(request)
    const code = query.code
    const state = query.state
    if (!code || !state) throw badRequest('回调缺少 code 或 state')
    if (request.cookies?.sa_oauth_state !== state) throw badRequest('登录状态校验失败，请重试')
    const parsed = readOAuthState(ctx.config, state)
    if (!parsed || parsed.provider !== provider) throw badRequest('登录状态已过期，请重试')

    try {
      const identity = await oauth.exchange({ code, redirectUri: `${ctx.config.PUBLIC_BASE_URL}/v1/auth/${provider}/callback` })
      const user = await loginWithIdentity(ctx, provider, identity)
      const session = await createSession(ctx, user.id, {
        userAgent: request.headers['user-agent'] ?? null,
        ip: request.ip,
      })
      setSessionCookie(ctx.config, reply, session.token, session.expiresAt)
      clearOAuthCookie(reply)
      return reply.redirect(safeReturnTo(parsed.returnTo))
    } catch (error) {
      ctx.log.warn({ err: error, provider }, 'OAuth login failed')
      clearOAuthCookie(reply)
      return reply.redirect('/login?error=oauth_failed')
    }
  })
}
