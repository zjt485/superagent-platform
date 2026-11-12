import { and, eq, gt, sql } from 'drizzle-orm'
import type { Config } from '../config.js'
import type { Deps } from './deps.js'
import { authSessions, identities, users, type UserRow } from '../db/schema.js'
import { newId } from '../domain/ids.js'
import { conflict, notFound, unauthorized } from '../errors.js'
import { randomToken, sha256, signValue, verifyValue } from '../security/tokens.js'
import type { OAuthIdentity } from '../domain/oauth.js'

export interface AuthUser {
  id: string
  name: string
  avatar: string | null
  email: string | null
  isAdmin: boolean
}

export interface SessionResult {
  token: string
  expiresAt: Date
  user: AuthUser
}

export const toAuthUser = (row: UserRow): AuthUser => ({
  id: row.id,
  name: row.name,
  avatar: row.avatar,
  email: row.email,
  isAdmin: row.isAdmin,
})

function adminExternalIds(config: Config): string[] {
  return (config.PLATFORM_ADMIN_EXTERNAL_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

/** Finds the user for an identity or creates one; identities never cross-link. */
export async function loginWithIdentity(deps: Deps, provider: string, identity: OAuthIdentity): Promise<AuthUser> {
  const [existing] = await deps.db
    .select({ user: users })
    .from(identities)
    .innerJoin(users, eq(users.id, identities.userId))
    .where(and(eq(identities.provider, provider), eq(identities.externalId, identity.externalId)))

  const isAdmin = adminExternalIds(deps.config).includes(identity.externalId) || adminExternalIds(deps.config).includes(`${provider}:${identity.externalId}`)
  if (existing) {
    const patch: Partial<typeof users.$inferInsert> = { updatedAt: deps.now() }
    if (identity.name && identity.name !== existing.user.name) patch.name = identity.name
    if (identity.avatar && identity.avatar !== existing.user.avatar) patch.avatar = identity.avatar
    if (identity.email && identity.email !== existing.user.email) patch.email = identity.email
    if (isAdmin !== existing.user.isAdmin) patch.isAdmin = isAdmin
    await deps.db.update(users).set(patch).where(eq(users.id, existing.user.id))
    const [updated] = await deps.db.select().from(users).where(eq(users.id, existing.user.id))
    return toAuthUser(updated ?? existing.user)
  }

  const userId = newId()
  await deps.db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      name: identity.name || `${provider} 用户`,
      avatar: identity.avatar ?? null,
      email: identity.email ?? null,
      isAdmin,
      createdAt: deps.now(),
      updatedAt: deps.now(),
    })
    await tx.insert(identities).values({
      id: newId(),
      userId,
      provider,
      externalId: identity.externalId,
      displayName: identity.name ?? null,
      createdAt: deps.now(),
    })
  })
  const [row] = await deps.db.select().from(users).where(eq(users.id, userId))
  if (!row) throw new Error('failed to create user')
  return toAuthUser(row)
}

export async function createSession(
  deps: Deps,
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<SessionResult> {
  const token = randomToken(32)
  const expiresAt = new Date(deps.now().getTime() + deps.config.SESSION_TTL_HOURS * 3_600_000)
  await deps.db.insert(authSessions).values({
    id: newId(),
    userId,
    tokenHash: sha256(token),
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
    createdAt: deps.now(),
    lastSeenAt: deps.now(),
    expiresAt,
  })
  const [row] = await deps.db.select().from(users).where(eq(users.id, userId))
  if (!row) throw notFound('用户不存在')
  return { token, expiresAt, user: toAuthUser(row) }
}

export async function userBySession(deps: Deps, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null
  const [row] = await deps.db
    .select({ user: users, sessionId: authSessions.id })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.tokenHash, sha256(token)), gt(authSessions.expiresAt, deps.now())))
  if (!row) return null
  await deps.db.update(authSessions).set({ lastSeenAt: deps.now() }).where(eq(authSessions.id, row.sessionId))
  return toAuthUser(row.user)
}

export async function destroySession(deps: Deps, token: string | undefined): Promise<void> {
  if (!token) return
  await deps.db.delete(authSessions).where(eq(authSessions.tokenHash, sha256(token)))
}

export async function devLogin(deps: Deps, input: { name: string; externalId?: string }): Promise<SessionResult> {
  if (!deps.config.AUTH_DEV_LOGIN) throw unauthorized('开发登录未开启')
  const name = input.name.trim()
  if (!name) throw conflict('请输入昵称')
  const externalId = input.externalId?.trim() || `dev-${name.toLowerCase().replace(/\s+/g, '-').slice(0, 40)}`
  const user = await loginWithIdentity(deps, 'dev', { externalId, name })
  return createSession(deps, user.id)
}

// ---------------------------------------------------------------------------
// OAuth state: signed, short lived, and bound to the provider and return path.
// ---------------------------------------------------------------------------

export interface OAuthState {
  provider: 'feishu' | 'wecom'
  nonce: string
  returnTo: string
  inviteToken?: string
  expiresAt: number
}

const STATE_TTL_MS = 10 * 60_000

export function safeReturnTo(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string') return fallback
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback
  return value.slice(0, 500)
}

export function createOAuthState(config: Config, input: { provider: 'feishu' | 'wecom'; returnTo?: string; inviteToken?: string }): string {
  const payload: OAuthState = {
    provider: input.provider,
    nonce: randomToken(16),
    returnTo: safeReturnTo(input.returnTo),
    ...(input.inviteToken ? { inviteToken: input.inviteToken.slice(0, 200) } : {}),
    expiresAt: Date.now() + STATE_TTL_MS,
  }
  return signValue(config.SESSION_SECRET, payload as unknown as Record<string, unknown>)
}

export function readOAuthState(config: Config, state: string): OAuthState | null {
  const payload = verifyValue<Record<string, unknown>>(config.SESSION_SECRET, state)
  if (!payload) return null
  if (payload.provider !== 'feishu' && payload.provider !== 'wecom') return null
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt < Date.now()) return null
  if (typeof payload.returnTo !== 'string') return null
  return payload as unknown as OAuthState
}

export async function cleanupExpiredSessions(deps: Deps): Promise<number> {
  const result = await deps.db.delete(authSessions).where(sql`${authSessions.expiresAt} <= now()`)
  return Number((result as unknown as { count?: number }).count ?? 0)
}
