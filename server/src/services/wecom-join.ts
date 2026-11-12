import { and, eq } from 'drizzle-orm'
import QRCode from 'qrcode'
import type { Deps } from './deps.js'
import type { ImRegistry } from '../domain/im.js'
import { AppError, conflict, notFound } from '../errors.js'

import { newId } from '../domain/ids.js'
import { audit } from './audit.js'
import { bindChannel, updateProject } from './projects.js'
import { requireProjectAccess } from './access.js'
import { joinProjectGroup, type GroupJoinOutcome } from './group-join.js'
import { signValue, verifyValue } from '../security/tokens.js'
import {
  channels,
  identities,
  projectMembers,
  projects,
  repos,
  type ChannelRow,
  type ProjectRow,
} from '../db/schema.js'

export interface WecomJoinDeps extends Deps {
  im: ImRegistry
}

export interface ProjectJoinLink {
  token: string
  url: string
  qrDataUrl: string
  expiresAt: Date
}

export interface ManagedGroupSetup {
  project: ProjectRow
  channel: ChannelRow
  group: { chatId: string; name: string; managed: true; autoJoin: true }
  join: ProjectJoinLink
}

export interface JoinPreview {
  valid: boolean
  reason?: 'invalid' | 'expired' | 'group_missing' | 'archived'
  project?: { id: string; name: string; slug: string; status: string }
  group?: { provider: 'wecom'; chatId: string; name: string | null; managed: boolean }
  expiresAt?: string
}

interface JoinPayload extends Record<string, unknown> {
  kind: 'wecom-join'
  projectId: string
  channelId: string
  exp: number
}

const JOIN_TTL_MS = 90 * 24 * 3_600_000

function configOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function isManaged(channel: ChannelRow): boolean {
  return channel.provider === 'wecom' && configOf(channel.config).managed === true
}

async function activeChannel(deps: WecomJoinDeps, projectId: string): Promise<ChannelRow | null> {
  const [row] = await deps.db
    .select()
    .from(channels)
    .where(and(eq(channels.projectId, projectId), eq(channels.status, 'active')))
    .limit(1)
  return row ?? null
}

export async function createJoinLink(deps: WecomJoinDeps, project: ProjectRow, channel: ChannelRow): Promise<ProjectJoinLink> {
  const expiresAt = new Date(deps.now().getTime() + JOIN_TTL_MS)
  const token = signValue(deps.config.SESSION_SECRET, {
    kind: 'wecom-join',
    projectId: project.id,
    channelId: channel.id,
    exp: expiresAt.getTime(),
  } satisfies JoinPayload)
  const url = `${deps.config.PUBLIC_BASE_URL}/join/${encodeURIComponent(token)}`
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: 'M' })
  return { token, url, qrDataUrl, expiresAt }
}

export async function existingManagedJoin(
  deps: WecomJoinDeps,
  projectId: string,
): Promise<{ project: ProjectRow; channel: ChannelRow; join: ProjectJoinLink } | null> {
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId))
  if (!project) throw notFound('项目不存在')
  const channel = await activeChannel(deps, projectId)
  if (!channel || !isManaged(channel)) return null
  return { project, channel, join: await createJoinLink(deps, project, channel) }
}

/**
 * Creates an app-managed WeCom chat with the current Owner and all project
 * members that have a WeCom identity. The platform QR then adds scanners via
 * `appchat/update`; arbitrary existing groups cannot be targeted by the API.
 */
export async function createManagedWecomGroup(
  deps: WecomJoinDeps,
  projectId: string,
  actor: { id: string; name: string; isAdmin: boolean },
): Promise<ManagedGroupSetup> {
  const access = await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'owner')
  const project = access.project
  const [repo] = await deps.db.select().from(repos).where(eq(repos.projectId, projectId))
  if (!repo) throw conflict('请先绑定 GitHub 仓库，再创建企业微信群')
  const current = await activeChannel(deps, projectId)
  if (current) {
    if (!isManaged(current)) throw conflict('项目已绑定其他群；请先在控制台解绑，再创建企业微信群')
    const join = await createJoinLink(deps, project, current)
    return {
      project,
      channel: current,
      group: { chatId: current.externalChatId, name: current.name ?? '', managed: true, autoJoin: true },
      join,
    }
  }

  const adapter = deps.im.wecom
  if (!adapter?.createChat) {
    throw new AppError(503, 'internal', '企业微信未配置自建应用（CorpID/Secret），无法创建应用群')
  }
  const [ownerIdentity] = await deps.db
    .select({ externalId: identities.externalId })
    .from(identities)
    .where(and(eq(identities.userId, actor.id), eq(identities.provider, 'wecom')))
  if (!ownerIdentity?.externalId) {
    throw conflict('请先使用企业微信登录，再创建企业微信群')
  }

  const memberRows = await deps.db
    .select({ externalId: identities.externalId })
    .from(identities)
    .innerJoin(projectMembers, eq(projectMembers.userId, identities.userId))
    .where(and(eq(projectMembers.projectId, projectId), eq(identities.provider, 'wecom')))
  const userIds = [...new Set([ownerIdentity.externalId, ...memberRows.map((row) => row.externalId)])].filter(Boolean)
  const chatName = `${project.name} · Superagent`.slice(0, 64)
  const { chatId } = await adapter.createChat({ name: chatName, ownerUserId: ownerIdentity.externalId, userIds })

  await bindChannel(deps, projectId, actor, {
    provider: 'wecom',
    externalChatId: chatId,
    name: chatName,
    config: { managed: true, autoJoin: true },
  })
  const [channel] = await deps.db
    .select()
    .from(channels)
    .where(and(eq(channels.projectId, projectId), eq(channels.status, 'active')))
  if (!channel) throw new Error('failed to bind WeCom group')

  // A project becomes active as soon as repo + group are both present.
  if (project.status === 'draft') {
    await updateProject(deps, projectId, actor, { status: 'active' })
  }
  const [updated] = await deps.db.select().from(projects).where(eq(projects.id, projectId))
  const join = await createJoinLink(deps, updated ?? project, channel)
  await audit(deps, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'wecom.group_created',
    target: `channel:${channel.id}`,
    metadata: { chatId, memberCount: userIds.length },
  })
  return {
    project: updated ?? project,
    channel,
    group: { chatId, name: chatName, managed: true, autoJoin: true },
    join,
  }
}

export async function getJoinLink(
  deps: WecomJoinDeps,
  projectId: string,
  actor: { id: string; isAdmin: boolean },
): Promise<{ channel: ChannelRow | null; join: ProjectJoinLink | null; reason?: string }> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'maintainer')
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId))
  if (!project) throw notFound('项目不存在')
  const channel = await activeChannel(deps, projectId)
  if (!channel) return { channel: null, join: null, reason: 'no_channel' }
  if (!isManaged(channel)) return { channel, join: null, reason: 'not_managed' }
  return { channel, join: await createJoinLink(deps, project, channel) }
}

function readPayload(deps: WecomJoinDeps, token: string): JoinPayload | null {
  const payload = verifyValue<JoinPayload>(deps.config.SESSION_SECRET, token)
  if (!payload || payload.kind !== 'wecom-join') return null
  if (typeof payload.projectId !== 'string' || typeof payload.channelId !== 'string' || typeof payload.exp !== 'number') return null
  if (payload.exp <= deps.now().getTime()) return null
  return payload
}

export async function previewJoinLink(deps: WecomJoinDeps, token: string): Promise<JoinPreview> {
  const payload = readPayload(deps, token)
  if (!payload) return { valid: false, reason: 'invalid' }
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, payload.projectId))
  const [channel] = await deps.db.select().from(channels).where(eq(channels.id, payload.channelId))
  if (!project || !channel || channel.status !== 'active' || !isManaged(channel)) {
    return { valid: false, reason: 'group_missing' }
  }
  if (project.status === 'archived') return { valid: false, reason: 'archived' }
  return {
    valid: true,
    project: { id: project.id, name: project.name, slug: project.slug, status: project.status },
    group: { provider: 'wecom', chatId: channel.externalChatId, name: channel.name, managed: true },
    expiresAt: new Date(payload.exp).toISOString(),
  }
}

export async function acceptJoinLink(
  deps: WecomJoinDeps,
  token: string,
  user: { id: string; name: string },
): Promise<{
  projectId: string
  role: string
  alreadyMember: boolean
  group: GroupJoinOutcome
}> {
  const payload = readPayload(deps, token)
  if (!payload) throw conflict('入群链接无效或已过期')
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, payload.projectId))
  const [channel] = await deps.db.select().from(channels).where(eq(channels.id, payload.channelId))
  if (!project || !channel || channel.status !== 'active' || !isManaged(channel)) {
    throw conflict('对应的企业微信群已失效，请联系项目 Owner 重新生成二维码')
  }
  if (project.status === 'archived') throw conflict('项目已归档')

  const [existing] = await deps.db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, user.id)))
  if (!existing) {
    await deps.db.insert(projectMembers).values({
      id: newId(),
      projectId: project.id,
      userId: user.id,
      role: 'member',
      joinedAt: deps.now(),
    })
  }
  const group = await joinProjectGroup(deps, project.id, user)
  await audit(deps, {
    projectId: project.id,
    actorId: user.id,
    actorLabel: user.name,
    action: 'wecom.join_link_accepted',
    target: `project:${project.id}`,
    metadata: {
      alreadyMember: Boolean(existing),
      chatId: channel.externalChatId,
      joined: group.joined,
      ...(group.error ? { error: group.error.slice(0, 300) } : {}),
    },
  })
  return {
    projectId: project.id,
    role: existing?.role ?? 'member',
    alreadyMember: Boolean(existing),
    group,
  }
}


