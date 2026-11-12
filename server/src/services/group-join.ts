import { and, eq } from 'drizzle-orm'
import type { Deps } from './deps.js'
import type { ImRegistry } from '../domain/im.js'
import type { ChannelProvider } from '../domain/status.js'
import { channels, identities } from '../db/schema.js'
import { audit } from './audit.js'

export interface ProjectGroupInfo {
  provider: ChannelProvider
  name: string | null
  chatId: string
  /** A URL a newly joined member can open to enter the group. */
  joinUrl: string | null
  /** An image (data URL or HTTPS URL) the owner exported from the IM client. */
  qrDataUrl: string | null
  /** Whether the platform is allowed to add the member automatically. */
  autoJoin: boolean
}

export interface GroupJoinOutcome {
  group: ProjectGroupInfo | null
  joined: boolean
  error?: string
}

export interface GroupJoinDeps extends Deps {
  im: ImRegistry
}

const FEISHU_OPEN_CHAT = (chatId: string) =>
  `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`

function configOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function validImage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length > 1_200_000) return null
  if (value.startsWith('data:image/')) return value
  if (/^https?:\/\//i.test(value)) return value
  return null
}

function validUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null
  return /^https?:\/\//i.test(value) ? value : null
}

/** Active channel → the information an invitee needs to enter the project group. */
export async function projectGroupInfo(deps: Deps, projectId: string): Promise<ProjectGroupInfo | null> {
  const [channel] = await deps.db
    .select()
    .from(channels)
    .where(and(eq(channels.projectId, projectId), eq(channels.status, 'active')))
  if (!channel) return null
  const config = configOf(channel.config)
  const configuredJoinUrl = validUrl(config.joinUrl)
  return {
    provider: channel.provider,
    name: channel.name,
    chatId: channel.externalChatId,
    joinUrl:
      configuredJoinUrl ??
      (channel.provider === 'feishu' ? FEISHU_OPEN_CHAT(channel.externalChatId) : null),
    qrDataUrl: validImage(config.qrDataUrl),
    autoJoin: config.autoJoin !== false,
  }
}

async function externalIdentityFor(
  deps: Deps,
  userId: string,
  provider: ChannelProvider,
): Promise<string | null> {
  const [row] = await deps.db
    .select({ externalId: identities.externalId })
    .from(identities)
    .where(and(eq(identities.userId, userId), eq(identities.provider, provider)))
  return row?.externalId ?? null
}

/**
 * Best-effort automatic group add after an invitation is accepted. A failure
 * never fails the join: the UI then shows the group QR code / invite link.
 */
export async function joinProjectGroup(
  deps: GroupJoinDeps,
  projectId: string,
  user: { id: string; name: string },
): Promise<GroupJoinOutcome> {
  const group = await projectGroupInfo(deps, projectId)
  if (!group) return { group: null, joined: false }

  const adapter = deps.im[group.provider]
  if (!adapter?.addMembers || !group.autoJoin) {
    return { group, joined: false }
  }

  const externalId = await externalIdentityFor(deps, user.id, group.provider)
  if (!externalId) {
    // The user logged in with dev/another identity; show the fallback instead.
    return { group, joined: false }
  }

  try {
    await adapter.addMembers({ chatId: group.chatId, externalUserIds: [externalId] })
    await audit(deps, {
      projectId,
      actorId: user.id,
      actorLabel: user.name,
      action: 'channel.auto_join_succeeded',
      target: `channel:${group.provider}:${group.chatId}`,
    })
    return { group, joined: true }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
    deps.log.warn({ err: error, projectId, chatId: group.chatId }, 'automatic group join failed')
    await audit(deps, {
      projectId,
      actorId: user.id,
      actorLabel: user.name,
      action: 'channel.auto_join_failed',
      target: `channel:${group.provider}:${group.chatId}`,
      metadata: { error: message },
    })
    return { group, joined: false, error: message }
  }
}
