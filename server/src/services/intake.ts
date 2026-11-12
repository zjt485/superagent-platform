import { and, eq } from 'drizzle-orm'
import type { OrchestratorContext } from './orchestrator.js'
import { approvePlanAndExecute, cancelTicket, enqueuePlan, resumeTicket, retryTicket } from './orchestrator.js'
import { channelByExternalChat, bindChannel, projectBySlug } from './projects.js'
import { getMembership } from './access.js'
import {
  createTicket,
  getTicketById,
  resolveTicket,
  ticketForThread,
  ticketRef,
} from './tickets.js'
import { notifications } from './notifications.js'
import { audit } from './audit.js'
import { AppError } from '../errors.js'
import { newId, shortId } from '../domain/ids.js'
import { decideIntake, parseCommand, type ParsedCommand } from '../domain/intake.js'
import { threadKeyFor, ticketTitle, type InboundEvent, type InboundMessage } from '../domain/message.js'
import { atLeast } from '../domain/status.js'
import {
  channels,
  identities,
  intakeEvents,
  messages,
  projects,
  tickets,
  users,
  webhookDeliveries,
  type ChannelRow,
  type MessageRow,
} from '../db/schema.js'
import { isUniqueViolation } from '../db/errors.js'

export interface IngestResult {
  action: string
  reason?: string
  ticketId?: string
  duplicate?: boolean
}

/** Releases a delivery reservation after processing failed, so the provider
 * retry is not mistaken for a duplicate. */
export async function forgetDelivery(deps: OrchestratorContext, provider: string, deliveryId: string): Promise<void> {
  await deps.db
    .delete(webhookDeliveries)
    .where(and(eq(webhookDeliveries.provider, provider), eq(webhookDeliveries.deliveryId, deliveryId.slice(0, 200))))
    .catch((error) => deps.log.warn({ err: error, provider, deliveryId }, 'failed to release webhook delivery'))
}

/** Returns false when this provider delivery id was already processed (§12.7). */
export async function registerDelivery(
  deps: OrchestratorContext,
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

async function userIdForExternal(deps: OrchestratorContext, provider: string, externalId: string): Promise<string | null> {
  const [row] = await deps.db
    .select({ userId: identities.userId })
    .from(identities)
    .where(and(eq(identities.provider, provider), eq(identities.externalId, externalId)))
  return row?.userId ?? null
}

async function insertMessage(
  ctx: OrchestratorContext,
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

async function recordIntake(
  ctx: OrchestratorContext,
  input: {
    projectId: string
    messageId: string
    action: 'ticket_created' | 'ticket_appended' | 'command' | 'ignored' | 'duplicate'
    reason?: string
    command?: string
    ticketId?: string | null
  },
): Promise<void> {
  try {
    await ctx.db.insert(intakeEvents).values({
      id: newId(),
      projectId: input.projectId,
      messageId: input.messageId,
      action: input.action,
      reason: input.reason?.slice(0, 200) ?? null,
      command: input.command ?? null,
      ticketId: input.ticketId ?? null,
      createdAt: ctx.now(),
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }
}

const HELP_TEXT = [
  '可用命令：',
  '/status [工单号] 查看工单',
  '/cancel [工单号] 取消工单（Maintainer+）',
  '/retry [工单号] 重试失败/取消的工单（Maintainer+）',
  '/approve [工单号] 批准计划（Maintainer+）',
  '/bind <项目标识> 绑定当前群（项目 Owner，在未绑定的群里使用）',
  '/help 查看帮助',
  '直接 @我 并描述需求即可创建工单；工单线程内的回复会追加到同一工单。',
].join('\n')

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    new: '新建',
    triaged: '已受理',
    planned: '待审批计划',
    running: '执行中',
    waiting_review: '待评审',
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }
  return labels[status] ?? status
}

async function replyCommand(
  ctx: OrchestratorContext,
  channel: ChannelRow,
  message: InboundMessage,
  text: string,
): Promise<void> {
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, channel.projectId))
  if (!project) return
  await notifications.message(ctx, project, channel.id, text, message.providerMessageId, `cmd:${message.providerMessageId}`)
}

async function commandExecution(
  ctx: OrchestratorContext,
  channel: ChannelRow,
  message: InboundMessage,
  userId: string | null,
  userIsAdmin: boolean,
  command: ParsedCommand,
  threadTicketId: string | null,
  authorized: boolean,
  denialReason: string | undefined,
): Promise<{ ticketId?: string }> {
  if (!authorized) {
    const text =
      denialReason === 'unknown_command'
        ? `未知命令。\n${HELP_TEXT}`
        : denialReason === 'project_paused'
          ? '项目已暂停，暂不接收新指令。Maintainer 仍可取消工单。'
          : '你的角色没有权限执行该命令。'
    await replyCommand(ctx, channel, message, text)
    return {}
  }
  if (!userId) return {}

  const actorName = message.sender.name ?? '成员'
  const actor = { id: userId, name: actorName, isAdmin: userIsAdmin }
  const threadKey = message.threadKey
  const resolveRef = async (): Promise<string | null> => {
    if (command.arg) return command.arg
    try {
      const ticket = await resolveTicket(ctx, channel.projectId, {
        ...(threadTicketId ? { ref: threadTicketId } : {}),
        channelId: channel.id,
        threadKey,
      })
      return ticket.id
    } catch {
      return null
    }
  }

  switch (command.name) {
    case 'help': {
      await replyCommand(ctx, channel, message, HELP_TEXT)
      return {}
    }
    case 'status': {
      const ref = await resolveRef()
      if (!ref) {
        await replyCommand(ctx, channel, message, '当前会话没有可查询的工单。使用 `/status #工单号`。')
        return {}
      }
      const ticket = await getTicketById(ctx, ref)
      const lines = [
        `📋 ${ticketRef(ticket)} ${ticket.title}`,
        `状态：${statusLabel(ticket.status)}　优先级：${ticket.priority}`,
        ...(ticket.plan ? [`计划：${ticket.plan.slice(0, 500)}`] : []),
        ...(ticket.branch ? [`分支：${ticket.branch}`] : []),
        ...(ticket.prUrl ? [`PR：${ticket.prUrl}`] : []),
      ]
      await replyCommand(ctx, channel, message, lines.join('\n'))
      return { ticketId: ticket.id }
    }
    case 'cancel': {
      const ref = await resolveRef()
      if (!ref) {
        await replyCommand(ctx, channel, message, '没有可取消的工单。使用 `/cancel #工单号`。')
        return {}
      }
      const ticket = await cancelTicket(ctx, ref, actor)
      await replyCommand(ctx, channel, message, `🛑 已取消 ${ticketRef(ticket)}。`)
      return { ticketId: ticket.id }
    }
    case 'retry': {
      const ref = await resolveRef()
      if (!ref) {
        await replyCommand(ctx, channel, message, '没有可重试的工单。使用 `/retry #工单号`。')
        return {}
      }
      await retryTicket(ctx, ref, actor)
      await replyCommand(ctx, channel, message, `🔁 已重新排队 ${ref.startsWith('#') ? ref : `#${shortId(ref)}`}。`)
      return { ticketId: ref }
    }
    case 'approve': {
      const ref = await resolveRef()
      if (!ref) {
        await replyCommand(ctx, channel, message, '没有待审批的工单。使用 `/approve #工单号`。')
        return {}
      }
      await approvePlanAndExecute(ctx, ref, actor)
      await replyCommand(ctx, channel, message, `✅ 已批准并开始执行 #${shortId(ref)}。`)
      return { ticketId: ref }
    }
    case 'bind': {
      if (!command.arg) {
        await replyCommand(ctx, channel, message, '用法：`/bind <项目标识>`')
        return {}
      }
      if (command.arg.toLowerCase() === channel.projectId) {
        await replyCommand(ctx, channel, message, '当前群已绑定项目。')
        return {}
      }
      await replyCommand(ctx, channel, message, '当前群已绑定其他项目。请先在控制台解绑，或在未绑定的群里执行 /bind。')
      return {}
    }
    default: {
      await replyCommand(ctx, channel, message, HELP_TEXT)
      return {}
    }
  }
}

/**
 * Binds an unbound chat through `@bot /bind <project-slug>` (§4.2 step 6).
 * Returns null when the message is not a bind request or cannot be authorized.
 */
async function tryBindUnboundChat(
  ctx: OrchestratorContext,
  message: InboundMessage,
  command: ParsedCommand,
): Promise<IngestResult | null> {
  if (command.name !== 'bind' || !command.arg || !message.mentionBot) return null
  const userId = await userIdForExternal(ctx, message.provider, message.sender.externalId)
  const project = await projectBySlug(ctx, command.arg)
  if (!project) {
    ctx.log.info({ chatId: message.externalChatId, slug: command.arg }, 'bind requested for unknown project')
    return { action: 'ignored', reason: 'bind_project_not_found' }
  }
  if (!userId) return { action: 'ignored', reason: 'not_member' }
  const role = await getMembership(ctx, project.id, userId)
  if (!atLeast(role, 'owner')) {
    ctx.log.info({ projectId: project.id, userId }, 'bind denied: not owner')
    return { action: 'ignored', reason: 'bind_not_owner' }
  }
  const [user] = await ctx.db.select().from(users).where(eq(users.id, userId))
  const actor = { id: userId, name: user?.name ?? message.sender.name ?? '成员', isAdmin: user?.isAdmin ?? false }
  try {
    await bindChannel(ctx, project.id, actor, {
      provider: message.provider,
      externalChatId: message.externalChatId,
    })
  } catch (error) {
    const text = error instanceof AppError ? error.message : '绑定失败'
    ctx.log.warn({ err: error, projectId: project.id }, 'bind failed')
    // No channel binding exists yet, so this reply is only logged.
    ctx.log.info({ chatId: message.externalChatId, text }, 'bind failure reply (not deliverable without binding)')
    return { action: 'ignored', reason: 'bind_failed' }
  }
  const [channel] = await ctx.db
    .select()
    .from(channels)
    .where(and(eq(channels.provider, message.provider), eq(channels.externalChatId, message.externalChatId)))
  if (!channel) return { action: 'ignored', reason: 'bind_failed' }
  const stored = await insertMessage(ctx, channel, message, userId, threadKeyFor(message))
  await recordIntake(ctx, {
    projectId: project.id,
    messageId: stored.row.id,
    action: 'command',
    reason: 'bind',
    command: 'bind',
  })
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

export async function ingestInboundEvent(ctx: OrchestratorContext, event: InboundEvent): Promise<IngestResult[]> {
  const results: IngestResult[] = []
  for (const message of event.messages) {
    if (!message.text.trim() && !message.mentionBot) {
      results.push({ action: 'ignored', reason: 'empty_message' })
      continue
    }
    const command = parseCommand(message.text)
    const channel = await channelByExternalChat(ctx, message.provider, message.externalChatId)
    if (!channel) {
      if (command) {
        const bound = await tryBindUnboundChat(ctx, message, command).catch((error) => {
          ctx.log.error({ err: error }, 'unbound bind handling failed')
          return null
        })
        if (bound) {
          results.push(bound)
          continue
        }
      }
      ctx.log.info({ provider: message.provider, chatId: message.externalChatId }, 'ignored message from unbound chat')
      results.push({ action: 'ignored', reason: 'not_project_chat' })
      continue
    }

    const [project] = await ctx.db.select().from(projects).where(eq(projects.id, channel.projectId))
    if (!project) {
      results.push({ action: 'ignored', reason: 'not_project_chat' })
      continue
    }
    const userId = await userIdForExternal(ctx, message.provider, message.sender.externalId)
    const threadKey = threadKeyFor(message)
    const key = message.threadKey || message.replyToMessageId || message.providerMessageId
    const stored = await insertMessage(ctx, channel, message, userId, key)
    if (stored.duplicate) {
      await audit(ctx, {
        projectId: project.id,
        action: 'webhook.duplicate_message',
        metadata: { provider: message.provider, providerMessageId: message.providerMessageId },
      })
      results.push({ action: 'duplicate', duplicate: true })
      continue
    }
    const user = userId ? (await ctx.db.select().from(users).where(eq(users.id, userId)))[0] : undefined
    const memberRole = userId ? await getMembership(ctx, project.id, userId) : null
    const threadTicket = await ticketForThread(ctx, project.id, channel.id, threadKey)
    const decision = decideIntake({
      isBotMessage: message.sender.isBot ?? false,
      channel: { projectId: project.id, projectStatus: project.status },
      memberRole,
      command,
      mentionBot: message.mentionBot,
      threadTicket: threadTicket ? { id: threadTicket.id, status: threadTicket.status } : null,
      policy: project.policyJson,
    })

    if (decision.action === 'ignored') {
      await recordIntake(ctx, {
        projectId: project.id,
        messageId: stored.row.id,
        action: 'ignored',
        reason: decision.reason,
        ...(command ? { command: command.name } : {}),
      })
      results.push({ action: 'ignored', reason: decision.reason })
      continue
    }

    if (decision.action === 'command') {
      const execution = await commandExecution(
        ctx,
        channel,
        message,
        userId,
        user?.isAdmin ?? false,
        { name: decision.command, arg: decision.arg, raw: command?.raw ?? '' },
        threadTicket?.id ?? null,
        decision.authorized,
        decision.reason,
      )
      await recordIntake(ctx, {
        projectId: project.id,
        messageId: stored.row.id,
        action: 'command',
        reason: decision.reason ?? decision.command,
        command: decision.command,
        ticketId: execution.ticketId ?? null,
      })
      results.push({ action: 'command', ...(decision.reason ? { reason: decision.reason } : {}), ...(execution.ticketId ? { ticketId: execution.ticketId } : {}) })
      continue
    }

    if (decision.action === 'ticket_created') {
      const ticket = await createTicket(ctx, {
        projectId: project.id,
        channelId: channel.id,
        threadKey,
        requesterId: userId,
        requesterName: message.sender.name ?? user?.name ?? null,
        title: ticketTitle(message.text),
        body: message.text,
      })
      await recordIntake(ctx, {
        projectId: project.id,
        messageId: stored.row.id,
        action: 'ticket_created',
        ticketId: ticket.id,
      })
      await notifications.receipt(ctx, ticket, message.sender.name ?? user?.name ?? '成员', message.providerMessageId)
      await enqueuePlan(ctx, ticket).catch(async (error) => {
        const reason = error instanceof AppError ? error.message : '无法启动计划'
        await notifications.failed(ctx, ticket, reason)
        ctx.log.error({ err: error, ticketId: ticket.id }, 'failed to enqueue plan')
      })
      results.push({ action: 'ticket_created', ticketId: ticket.id })
      continue
    }

    // ticket_appended
    const ticket = await getTicketById(ctx, decision.ticketId)
    await ctx.db
      .update(tickets)
      .set({ updatedAt: ctx.now(), requesterId: ticket.requesterId ?? userId })
      .where(eq(tickets.id, ticket.id))
    await recordIntake(ctx, {
      projectId: project.id,
      messageId: stored.row.id,
      action: 'ticket_appended',
      reason: decision.reopen ? 'reopened' : 'appended',
      ticketId: ticket.id,
    })
    if (decision.reopen) {
      await resumeTicket(ctx, ticket.id, message.text).catch((error) => {
        ctx.log.warn({ err: error, ticketId: ticket.id }, 'failed to resume ticket')
      })
    } else if (message.mentionBot) {
      await replyCommand(ctx, channel, message, `已追加到 ${ticketRef(ticket)}。`)
    }
    results.push({ action: 'ticket_appended', ticketId: ticket.id })
  }
  return results
}
