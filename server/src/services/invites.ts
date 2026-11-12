import { and, eq, sql } from 'drizzle-orm'
import QRCode from 'qrcode'
import type { Deps } from './deps.js'
import { channels, invites, projectMembers, projects, type InviteRow } from '../db/schema.js'
import { conflict, notFound } from '../errors.js'
import { newId } from '../domain/ids.js'
import type { MemberRole } from '../domain/status.js'
import { sha256 } from '../security/tokens.js'
import { audit } from './audit.js'
import { projectGroupInfo, type ProjectGroupInfo } from './group-join.js'

export interface CreateInviteInput {
  role?: MemberRole
  expiresInHours?: number
  maxUses?: number
}

export interface InviteView {
  id: string
  role: MemberRole
  expiresAt: Date
  maxUses: number
  usedCount: number
  createdAt: Date
  revokedAt: Date | null
  url: string
  qrDataUrl: string
}

export interface InvitePreview {
  valid: boolean
  reason?: 'not_found' | 'expired' | 'revoked' | 'exhausted' | 'archived'
  project: { id: string; name: string; slug: string; status: string } | null
  expiresAt?: Date
  maxUses?: number
  usedCount?: number
  role?: MemberRole
  chatProvider?: string
  group?: ProjectGroupInfo | null
}

async function inviteUrl(deps: Deps, token: string): Promise<string> {
  return `${deps.config.PUBLIC_BASE_URL}/invite/${encodeURIComponent(token)}`
}

export async function createInvite(
  deps: Deps,
  projectId: string,
  actor: { id: string; name: string },
  input: CreateInviteInput,
): Promise<{ invite: InviteView; token: string }> {
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId))
  if (!project) throw notFound('项目不存在')
  if (project.status === 'archived') throw conflict('已归档项目不能创建邀请')
  const role: MemberRole = input.role ?? 'member'
  if (role === 'owner') throw conflict('邀请不能授予 Owner')
  const expiresInHours = Math.min(Math.max(input.expiresInHours ?? 72, 1), 24 * 30)
  const maxUses = Math.min(Math.max(input.maxUses ?? 50, 1), 1000)
  const token = `inv_${newId().replace(/-/g, '')}_${deps.now().getTime().toString(36)}`
  const inviteId = newId()
  const expiresAt = new Date(deps.now().getTime() + expiresInHours * 3_600_000)
  await deps.db.insert(invites).values({
    id: inviteId,
    projectId,
    tokenHash: sha256(token),
    role,
    expiresAt,
    maxUses,
    usedCount: 0,
    createdBy: actor.id,
    createdAt: deps.now(),
  })
  await audit(deps, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'invite.created',
    target: `invite:${inviteId}`,
    metadata: { role, maxUses, expiresInHours },
  })
  const url = await inviteUrl(deps, token)
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: 'M' })
  return {
    token,
    invite: { id: inviteId, role, expiresAt, maxUses, usedCount: 0, createdAt: deps.now(), revokedAt: null, url, qrDataUrl },
  }
}

export async function listInvites(deps: Deps, projectId: string): Promise<Omit<InviteView, 'qrDataUrl'>[]> {
  const rows = await deps.db.select().from(invites).where(eq(invites.projectId, projectId)).orderBy(sql`created_at desc`)
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    expiresAt: row.expiresAt,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    url: '',
  }))
}

export async function revokeInvite(deps: Deps, projectId: string, inviteId: string, actor: { id: string; name: string }) {
  const [row] = await deps.db
    .select()
    .from(invites)
    .where(and(eq(invites.id, inviteId), eq(invites.projectId, projectId)))
  if (!row) throw notFound('邀请不存在')
  await deps.db.update(invites).set({ revokedAt: deps.now() }).where(eq(invites.id, inviteId))
  await audit(deps, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'invite.revoked',
    target: `invite:${inviteId}`,
  })
}

async function findByToken(deps: Deps, token: string): Promise<InviteRow | null> {
  const [row] = await deps.db.select().from(invites).where(eq(invites.tokenHash, sha256(token)))
  return row ?? null
}

export async function previewInvite(deps: Deps, token: string): Promise<InvitePreview> {
  const invite = await findByToken(deps, token)
  if (!invite) return { valid: false, reason: 'not_found', project: null }
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, invite.projectId))
  if (!project) return { valid: false, reason: 'not_found', project: null }
  const preview: InvitePreview = {
    valid: true,
    project: { id: project.id, name: project.name, slug: project.slug, status: project.status },
    expiresAt: invite.expiresAt,
    maxUses: invite.maxUses,
    usedCount: invite.usedCount,
    role: invite.role,
  }
  if (invite.revokedAt) return { ...preview, valid: false, reason: 'revoked' }
  if (invite.expiresAt.getTime() <= deps.now().getTime()) return { ...preview, valid: false, reason: 'expired' }
  if (invite.usedCount >= invite.maxUses) return { ...preview, valid: false, reason: 'exhausted' }
  if (project.status === 'archived') return { ...preview, valid: false, reason: 'archived' }
  const [channel] = await deps.db
    .select({ provider: channels.provider })
    .from(channels)
    .where(and(eq(channels.projectId, project.id), eq(channels.status, 'active')))
  if (channel) preview.chatProvider = channel.provider
  preview.group = await projectGroupInfo(deps, project.id)
  return preview
}

export async function acceptInvite(
  deps: Deps,
  token: string,
  user: { id: string; name: string },
): Promise<{ projectId: string; role: MemberRole; alreadyMember: boolean }> {
  const invite = await findByToken(deps, token)
  if (!invite) throw notFound('邀请无效或已过期')
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, invite.projectId))
  if (!project) throw notFound('邀请对应的项目不存在')
  if (project.status === 'archived') throw conflict('项目已归档，无法加入')
  if (invite.revokedAt) throw conflict('邀请已被撤销')
  if (invite.expiresAt.getTime() <= deps.now().getTime()) throw conflict('邀请已过期')
  if (invite.usedCount >= invite.maxUses) throw conflict('邀请使用次数已用完')

  const [existing] = await deps.db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, user.id)))
  if (existing) return { projectId: project.id, role: existing.role, alreadyMember: true }

  const [claimed] = await deps.db
    .update(invites)
    .set({ usedCount: sql`${invites.usedCount} + 1` })
    .where(and(eq(invites.id, invite.id), sql`${invites.usedCount} < ${invites.maxUses}`, sql`${invites.revokedAt} is null`))
    .returning()
  if (!claimed) throw conflict('邀请使用次数已用完')

  await deps.db.insert(projectMembers).values({
    id: newId(),
    projectId: project.id,
    userId: user.id,
    role: invite.role,
    invitedBy: invite.createdBy,
    joinedAt: deps.now(),
  })
  await audit(deps, {
    projectId: project.id,
    actorId: user.id,
    actorLabel: user.name,
    action: 'invite.accepted',
    target: `invite:${invite.id}`,
    metadata: { role: invite.role },
  })
  return { projectId: project.id, role: invite.role, alreadyMember: false }
}
