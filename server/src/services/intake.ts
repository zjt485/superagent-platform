import { and, eq } from 'drizzle-orm'
import { bindChannel, channelByExternalChat, projectBySlug } from './projects.js'
import { getMembership } from './access.js'
import { notifications } from './notifications.js'
import { audit } from './audit.js'
import { newId } from '../domain/ids.js'
import { parseCommand } from '../domain/intake.js'
import { threadKeyFor, type InboundEvent, type InboundMessage } from '../domain/message.js'
import { atLeast } from '../domain/status.js'
import {
  channels,
  identities,
  messages,
  projects,
  users,
  webhookDeliveries,
  type ChannelRow,
  type MessageRow,
} from '../db/schema.js'
import { isUniqueViolation } from '../db/errors.js'
import { receiveTrigger, type DualContext, type ReceiveResult } from '../dual/engine.js'
import { receiveCoreTrigger, type CoreIntakeResult } from '../core/intake.js'

export interface IngestResult {
  action: string
  reason?: string
  ticketId?: string
  evaluationId?: string
  duplicate?: boolean
}

export async function registerDelivery(
  deps: DualContext,
  provider: string,
  deliveryId: string,
  eventType: string,
): Promise<boolean> {
  try {
    await deps.db.insert(webhookDeliveries).values({
      id: newId(),
      provider,
      deliveryId: deliveryId.slice(0, 200),
      eventType: eventType.slice(0, 100),
      receivedAt: deps.now(),
    })
    return true
  } catch (error) {
    if (isUniqueViolation(error)) {
      await audit(deps, { action: 'webhook.duplicate', metadata: { provider, deliveryId } })
      return false
    }
    throw error
  }
}

export async function forgetDelivery(deps: DualContext, provider: string, deliveryId: string): Promise<void> {
  await deps.db
    .delete(webhookDeliveries)
    .where(and(eq(webhookDeliveries.provider, provider), eq(webhookDeliveries.deliveryId, deliveryId.slice(0, 200))))
    .catch((error) => deps.log.warn({ err: error, provider, deliveryId }, 'failed to release webhook delivery'))
}

async function identityUserId(deps: DualContext, provider: string, externalId: string): Promise<string | null> {
  const [row] = await deps.db
    .select({ userId: identities.userId })
    .from(identities)
    .where(and(eq(identities.provider, provider), eq(identities.externalId, externalId)))
  return row?.userId ?? null
}

async function insertMessage(
  ctx: DualContext,
  channel: ChannelRow,
  message: InboundMessage,
  userId: string | null,
  threadKey: string,
): Promise<{ row: MessageRow; duplicate: boolean }> {
  const existing = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.provider, message.provider), eq(messages.providerMessageId, message.providerMessageId)))
  if (existing[0]) return { row: existing[0], duplicate: true }
  try {
    const [row] = await ctx.db
      .insert(messages)
      .values({
        id: newId(),
        projectId: channel.projectId,
        channelId: channel.id,
        provider: message.provider,
        providerMessageId: message.providerMessageId,
        senderId: userId,
        externalSenderId: message.sender.externalId,
        senderName: message.sender.name ?? null,
        text: message.text.slice(0, 20_000),
        threadKey,
        replyToMessageId: message.replyToMessageId ?? null,
        isBot: message.sender.isBot ?? false,
        raw: message.raw ?? null,
        createdAt: ctx.now(),
      })
      .returning()
    if (!row) throw new Error('failed to store message')
    return { row, duplicate: false }
  } catch (error) {
    if (isUniqueViolation(error)) {
      const [row] = await ctx.db
        .select()
        .from(messages)
        .where(and(eq(messages.provider, message.provider), eq(messages.providerMessageId, message.providerMessageId)))
      if (row) return { row, duplicate: true }
    }
    throw error
  }
}

async function tryBindUnboundChat(ctx: DualContext, message: InboundMessage): Promise<IngestResult | null> {
  const command = parseCommand(message.text)
  if (command?.name !== 'bind' || !command.arg || !message.mentionBot) return null
  const userId = await identityUserId(ctx, message.provider, message.sender.externalId)
  const project = await projectBySlug(ctx, command.arg)
  if (!project) return { action: 'ignored', reason: 'bind_project_not_found' }
  if (!userId) return { action: 'ignored', reason: 'not_member' }
  const [user] = await ctx.db.select().from(users).where(eq(users.id, userId))
  const actor = { id: userId, name: user?.name ?? message.sender.name ?? '成员', isAdmin: user?.isAdmin ?? false }
  if (!atLeast(await getMembership(ctx, project.id, userId), 'owner')) return { action: 'ignored', reason: 'bind_not_owner' }
  try {
    await bindChannel(ctx, project.id, actor, { provider: message.provider, externalChatId: message.externalChatId })
  } catch (error) {
    ctx.log.warn({ err: error, projectId: project.id }, 'bind failed')
    return { action: 'ignored', reason: 'bind_failed' }
  }
  const [channel] = await ctx.db
    .select()
    .from(channels)
    .where(and(eq(channels.provider, message.provider), eq(channels.externalChatId, message.externalChatId)))
  if (!channel) return { action: 'ignored', reason: 'bind_failed' }
  const stored = await insertMessage(ctx, channel, message, userId, threadKeyFor(message))
  await notifications.message(ctx, project, channel.id, `✅ 已将本群绑定到项目「${project.name}」（${project.slug}）。`, message.providerMessageId, `bind:${stored.row.id}`)
  await audit(ctx, {
    projectId: project.id,
    actorId: userId,
    actorLabel: actor.name,
    action: 'channel.bound_by_command',
    target: `channel:${channel.id}`,
  })
  return { action: 'command', reason: 'bind' }
}

function mapResult(result: ReceiveResult): IngestResult {
  switch (result.action) {
    case 'duplicate':
      return { action: 'duplicate', duplicate: true }
    case 'evaluation':
      return { action: 'trigger_evaluated', reason: result.reason, ...(result.evaluationId ? { evaluationId: result.evaluationId } : {}) } as IngestResult
    case 'input':
      return { action: 'ticket_appended', ...(result.ticketIds?.[0] ? { ticketId: result.ticketIds[0] } : {}), reason: result.reason }
    case 'command':
      return { action: 'command', reason: result.reason, ...(result.ticketId ? { ticketId: result.ticketId } : {}) }
    case 'ignored':
      return { action: 'ignored', reason: result.reason }
  }
}

function mapCoreResult(result: CoreIntakeResult): IngestResult {
  switch (result.action) {
    case 'queued':
      return { action: 'trigger_evaluated', reason: 'core_router' }
    case 'command':
      return { action: 'command', reason: 'core_command' }
    case 'duplicate':
      return { action: 'duplicate', duplicate: true }
    case 'ignored':
      return { action: 'ignored', reason: 'core_intake' }
  }
}

export async function ingestInboundEvent(ctx: DualContext, event: InboundEvent): Promise<IngestResult[]> {
  const results: IngestResult[] = []
  for (const message of event.messages) {
    if (!message.text.trim() && !message.mentionBot) {
      results.push({ action: 'ignored', reason: 'empty_message' })
      continue
    }
    const channel = await channelByExternalChat(ctx, message.provider, message.externalChatId)
    if (!channel) {
      const bound = await tryBindUnboundChat(ctx, message).catch((error) => {
        ctx.log.error({ err: error }, 'unbound bind handling failed')
        return null
      })
      if (bound) {
        results.push(bound)
        continue
      }
      results.push({ action: 'ignored', reason: 'not_project_chat' })
      continue
    }
    const [project] = await ctx.db.select().from(projects).where(eq(projects.id, channel.projectId))
    if (!project) {
      results.push({ action: 'ignored', reason: 'not_project_chat' })
      continue
    }
    const userId = await identityUserId(ctx, message.provider, message.sender.externalId)
    const threadKey = threadKeyFor(message)
    const stored = await insertMessage(ctx, channel, message, userId, threadKey)
    if (stored.duplicate) {
      await audit(ctx, {
        projectId: project.id,
        action: 'webhook.duplicate_message',
        metadata: { provider: message.provider, providerMessageId: message.providerMessageId },
      })
      results.push({ action: 'duplicate', duplicate: true })
      continue
    }

    const command = parseCommand(message.text)
    if (ctx.config.CORE_ENABLED && command === null) {
      const role = userId === null ? null : await getMembership(ctx, project.id, userId)
      const core = await receiveCoreTrigger(ctx.db, {
        projectId: project.id,
        channelId: channel.id,
        provider: message.provider,
        externalId: message.providerMessageId,
        threadKey,
        actorUserId: userId,
        actorExternalId: message.sender.externalId,
        actorName: message.sender.name ?? null,
        text: message.text,
        address: message.mentionBot ? 'mention' : 'ambient',
        isBot: message.sender.isBot ?? false,
        mentionedBot: message.mentionBot,
        replyTo: message.replyToMessageId ?? null,
        raw: message.raw,
        authorized: role !== null && project.status === 'active',
        at: ctx.now(),
      })
      results.push(mapCoreResult(core))
      continue
    }
    const result = await receiveTrigger(ctx, {
      provider: message.provider,
      externalId: message.providerMessageId,
      chatId: message.externalChatId,
      threadKey,
      senderExternalId: message.sender.externalId,
      senderName: message.sender.name ?? null,
      isBot: message.sender.isBot ?? false,
      text: message.text,
      mentionBot: message.mentionBot,
      replyTo: message.replyToMessageId ?? null,
      messageId: stored.row.id,
      command,
      raw: message.raw,
    })
    results.push(mapResult(result))
  }
  return results
}


