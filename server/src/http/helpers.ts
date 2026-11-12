import { z } from 'zod'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError, unauthorized } from '../errors.js'
import type { Config } from '../config.js'

export const SESSION_COOKIE = 'sa_session'
export const OAUTH_COOKIE = 'sa_oauth_state'

export function requireUser(request: FastifyRequest): NonNullable<FastifyRequest['user']> {
  if (!request.user) throw unauthorized()
  return request.user
}

export function parseBody<T extends z.ZodType>(schema: T, request: FastifyRequest): z.infer<T> {
  const result = schema.safeParse(request.body)
  if (!result.success) {
    throw new AppError(400, 'bad_request', '请求参数不合法', result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })))
  }
  return result.data
}

export function parseQuery<T extends z.ZodType>(schema: T, request: FastifyRequest): z.infer<T> {
  const result = schema.safeParse(request.query)
  if (!result.success) {
    throw new AppError(400, 'bad_request', '查询参数不合法', result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })))
  }
  return result.data
}

export function queryOf(request: FastifyRequest): Record<string, string | undefined> {
  return (request.query ?? {}) as Record<string, string | undefined>
}

export function setSessionCookie(config: Config, reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.PUBLIC_BASE_URL.startsWith('https://'),
    expires: expiresAt,
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}

export function setOAuthCookie(reply: FastifyReply, state: string): void {
  reply.setCookie(OAUTH_COOKIE, state, {
    path: '/v1/auth',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 600,
  })
}

export function clearOAuthCookie(reply: FastifyReply): void {
  reply.clearCookie(OAUTH_COOKIE, { path: '/v1/auth' })
}

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

export const providerParamsSchema = z.object({ provider: z.enum(['feishu', 'wecom']) })
export const idParamsSchema = z.object({ id: z.string().uuid() })

export function pathParam(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown> | undefined)?.[name]
  if (typeof value !== 'string' || !value) throw new AppError(400, 'bad_request', `缺少路径参数 ${name}`)
  return value
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** IDs that fail the UUID shape cannot exist, so they map to 404 rather than a DB error. */
export function uuidParam(request: FastifyRequest, name = 'id'): string {
  const value = pathParam(request, name)
  if (!UUID.test(value)) throw new AppError(404, 'not_found', '资源不存在')
  return value
}
