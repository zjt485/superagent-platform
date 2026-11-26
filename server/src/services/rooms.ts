import { and, asc, desc, eq, inArray, or } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import type { Deps } from './deps.js'
import { audit } from './audit.js'
import { requireProjectAccess } from './access.js'
import { defaultEventBus, type ProjectEventBus } from './events.js'
import { formatBotSignature } from './bots.js'
import { newId } from '../domain/ids.js'
import { parseCommand } from '../domain/intake.js'
import { conflict, notFound } from '../errors.js'
import {
  bots,
  channels,
  outboxEvents,
  projects,
  roomBots,
  roomMessages,
  rooms,
  tickets,
  users,
  type BotRow,
  type ChannelRow,
  type RoomAttachment,
  type RoomMessageRow,
  type RoomRow,
} from '../db/schema.js'
import { receiveCoreTrigger } from '../core/intake.js'
import { handleCoreCommand } from '../core/commands.js'

export interface RoomWithMeta extends RoomRow {
  bots: Array<Pick<BotRow, 'id' | 'slug' | 'name' | 'roleTitle' | 'avatar' | 'status' | 'sandboxState'>>
  lastMessage: { content: string; authorName: string; createdAt: Date; kind: string } | null
}

export interface HydratedRoomMessage extends RoomMessageRow {
  authorName: string
  authorAvatar: string | null
  botSlug: string | null
  botRoleTitle: string | null
  ticketShortName: string | null
  ticketStage: string | null
}

/** Extract explicit `@bot-slug` mentions from message text. */
export function extractBotSlugMentions(text: string): string[] {
  const matches = text.matchAll(/[@＠]([a-z0-9][a-z0-9_-]{0,39})\b/gi)
  const slugs: string[] = []
  for (const match of matches) {
    const slug = match[1]?.toLowerCase()
    if (slug && !slugs.includes(slug)) slugs.push(slug)
  }
  return slugs
}

export async function resolveMentionedBot(
  db: Database,
  projectId: string,
  text: string,
): Promise<BotRow | null> {
  const slugs = extractBotSlugMentions(text)
  if (slugs.length === 0) return null
  const rows = await db
    .select()
    .from(bots)
    .where(and(eq(bots.projectId, projectId), eq(bots.status, 'active'), inArray(bots.slug, slugs)))
  if (rows.length === 0) return null
  const bySlug = new Map(rows.map((row) => [row.slug.toLowerCase(), row]))
  for (const slug of slugs) {
    const found = bySlug.get(slug)
    if (found) return found
  }
  return null
}

/** Ensure the project has at least one active main group room. */
export async function ensureDefaultGroupRoom(
  db: Database,
  projectId: string,
  at: Date,
  channelId: string | null = null,
): Promise<RoomRow> {
  const existing = await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.projectId, projectId), eq(rooms.kind, 'group'), eq(rooms.status, 'active')))
    .orderBy(asc(rooms.createdAt))
    .limit(1)
  if (existing[0]) {
    if (channelId && !existing[0].channelId) {
      const [updated] = await db
        .update(rooms)
        .set({ channelId, updatedAt: at })
        .where(eq(rooms.id, existing[0].id))
        .returning()
      return updated ?? existing[0]
    }
    return existing[0]
  }

  const id = newId()
  const [created] = await db
    .insert(rooms)
    .values({
      id,
      projectId,
      kind: 'group',
      name: '主协作群',
      topic: '团队与多 Bot 协作主房间',
      channelId,
      maxHandoffHops: 5,
      status: 'active',
      createdAt: at,
      updatedAt: at,
    })
    .returning()
  if (!created) throw new Error('ensureDefaultGroupRoom returned no row')

  const activeBots = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.projectId, projectId), eq(bots.status, 'active')))
  for (const bot of activeBots) {
    await db
      .insert(roomBots)
      .values({ id: newId(), roomId: created.id, botId: bot.id, joinedAt: at })
      .onConflictDoNothing()
  }
  return created
}

/** Find or create the Room bound to an external IM channel. */
export async function ensureChannelRoom(db: Database, projectId: string, channel: ChannelRow, at: Date): Promise<RoomRow> {
  const [existing] = await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.projectId, projectId), eq(rooms.channelId, channel.id)))
    .limit(1)
  if (existing) return existing
  return ensureDefaultGroupRoom(db, projectId, at, channel.id)
}

export async function listRooms(deps: Deps, projectId: string, userId: string): Promise<RoomWithMeta[]> {
  await ensureDefaultGroupRoom(deps.db, projectId, deps.now())
  const rows = await deps.db
    .select()
    .from(rooms)
    .where(
      and(
        eq(rooms.projectId, projectId),
        eq(rooms.status, 'active'),
        or(eq(rooms.kind, 'group'), eq(rooms.kind, 'routine_feed'), and(eq(rooms.kind, 'dm'), eq(rooms.dmUserId, userId))),
      ),
    )
    .orderBy(asc(rooms.kind), asc(rooms.createdAt))

  if (rows.length === 0) return []
  const roomIds = rows.map((row) => row.id)
  const links = await deps.db
    .select({
      roomId: roomBots.roomId,
      id: bots.id,
      slug: bots.slug,
      name: bots.name,
      roleTitle: bots.roleTitle,
      avatar: bots.avatar,
      status: bots.status,
      sandboxState: bots.sandboxState,
    })
    .from(roomBots)
    .innerJoin(bots, eq(bots.id, roomBots.botId))
    .where(inArray(roomBots.roomId, roomIds))

  const botsByRoom = new Map<string, RoomWithMeta['bots']>()
  for (const link of links) {
    const list = botsByRoom.get(link.roomId) ?? []
    list.push({
      id: link.id,
      slug: link.slug,
      name: link.name,
      roleTitle: link.roleTitle,
      avatar: link.avatar,
      status: link.status,
      sandboxState: link.sandboxState,
    })
    botsByRoom.set(link.roomId, list)
  }

  const recentMessages = await deps.db
    .select()
    .from(roomMessages)
    .where(inArray(roomMessages.roomId, roomIds))
    .orderBy(desc(roomMessages.createdAt))
    .limit(roomIds.length * 4)

  const latestByRoom = new Map<string, RoomMessageRow>()
  for (const msg of recentMessages) {
    if (!latestByRoom.has(msg.roomId)) latestByRoom.set(msg.roomId, msg)
  }

  const userIds = [...new Set([...latestByRoom.values()].map((m) => m.authorUserId).filter((v): v is string => Boolean(v)))]
  const botIds = [...new Set([...latestByRoom.values()].map((m) => m.authorBotId).filter((v): v is string => Boolean(v)))]
  const [userRows, botRows] = await Promise.all([
    userIds.length > 0 ? deps.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [],
    botIds.length > 0 ? deps.db.select({ id: bots.id, name: bots.name }).from(bots).where(inArray(bots.id, botIds)) : [],
  ])
  const userNameById = new Map(userRows.map((u) => [u.id, u.name]))
  const botNameById = new Map(botRows.map((b) => [b.id, b.name]))

  return rows.map((room) => {
    const last = latestByRoom.get(room.id)
    const authorName = !last
      ? ''
      : last.authorKind === 'bot'
        ? (botNameById.get(last.authorBotId ?? '') ?? 'Bot')
        : last.authorKind === 'user'
          ? (userNameById.get(last.authorUserId ?? '') ?? '成员')
          : '系统'
    return {
      ...room,
      bots: botsByRoom.get(room.id) ?? [],
      lastMessage: last
        ? {
            content: last.content.slice(0, 140),
            authorName,
            createdAt: last.createdAt,
            kind: last.kind,
          }
        : null,
    }
  })
}

export interface CreateRoomInput {
  kind: 'group' | 'dm' | 'routine_feed'
  name?: string
  topic?: string | null
  botIds?: string[]
  defaultBotId?: string | null
  maxHandoffHops?: number
}

export async function createRoom(
  deps: Deps,
  projectId: string,
  actor: { id: string; name: string; isAdmin: boolean },
  input: CreateRoomInput,
): Promise<RoomRow> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'member')
  const at = deps.now()

  if (input.kind === 'dm') {
    const targetBotId = input.defaultBotId ?? input.botIds?.[0]
    if (!targetBotId) throw conflict('私聊房间必须指定目标 Bot')
    const [bot] = await deps.db
      .select()
      .from(bots)
      .where(and(eq(bots.projectId, projectId), eq(bots.id, targetBotId)))
    if (!bot) throw notFound('Bot 不存在')

    const [existing] = await deps.db
      .select()
      .from(rooms)
      .where(
        and(
          eq(rooms.projectId, projectId),
          eq(rooms.kind, 'dm'),
          eq(rooms.dmUserId, actor.id),
          eq(rooms.defaultBotId, bot.id),
          eq(rooms.status, 'active'),
        ),
      )
      .limit(1)
    if (existing) return existing

    const id = newId()
    const [created] = await deps.db
      .insert(rooms)
      .values({
        id,
        projectId,
        kind: 'dm',
        name: input.name?.trim() || `与 ${bot.name} 私聊`,
        topic: input.topic ?? bot.roleTitle,
        dmUserId: actor.id,
        defaultBotId: bot.id,
        maxHandoffHops: input.maxHandoffHops ?? 5,
        status: 'active',
        createdAt: at,
        updatedAt: at,
      })
      .returning()
    if (!created) throw new Error('createRoom dm returned no row')
    await deps.db.insert(roomBots).values({ id: newId(), roomId: created.id, botId: bot.id, joinedAt: at }).onConflictDoNothing()
    return created
  }

  const name = input.name?.trim()
  if (!name) throw conflict('房间名称不能为空')
  const id = newId()
  const [created] = await deps.db
    .insert(rooms)
    .values({
      id,
      projectId,
      kind: input.kind,
      name,
      topic: input.topic ?? null,
      defaultBotId: input.defaultBotId ?? null,
      maxHandoffHops: Math.max(1, Math.min(input.maxHandoffHops ?? 5, 20)),
      status: 'active',
      createdAt: at,
      updatedAt: at,
    })
    .returning()
  if (!created) throw new Error('createRoom returned no row')

  const botIds =
    input.botIds && input.botIds.length > 0
      ? input.botIds
      : (
          await deps.db
            .select({ id: bots.id })
            .from(bots)
            .where(and(eq(bots.projectId, projectId), eq(bots.status, 'active')))
        ).map((row) => row.id)

  for (const botId of botIds) {
    await deps.db.insert(roomBots).values({ id: newId(), roomId: created.id, botId, joinedAt: at }).onConflictDoNothing()
  }

  await audit(deps, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'room.created',
    target: `room:${created.id}`,
    metadata: { kind: created.kind, name: created.name },
  })
  return created
}

export async function updateRoom(
  deps: Deps,
  projectId: string,
  roomId: string,
  actor: { id: string; name: string; isAdmin: boolean },
  input: { name?: string; topic?: string | null; maxHandoffHops?: number; botIds?: string[]; status?: 'active' | 'archived' },
): Promise<RoomRow> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'maintainer')
  const [existing] = await deps.db
    .select()
    .from(rooms)
    .where(and(eq(rooms.projectId, projectId), eq(rooms.id, roomId)))
  if (!existing) throw notFound('房间不存在')

  const at = deps.now()
  const patch: Partial<typeof rooms.$inferInsert> = { updatedAt: at }
  if (input.name !== undefined) patch.name = input.name.trim() || existing.name
  if (input.topic !== undefined) patch.topic = input.topic
  if (input.maxHandoffHops !== undefined) patch.maxHandoffHops = Math.max(1, Math.min(input.maxHandoffHops, 20))
  if (input.status !== undefined) patch.status = input.status

  const [updated] = await deps.db.update(rooms).set(patch).where(eq(rooms.id, roomId)).returning()
  if (input.botIds !== undefined) {
    await deps.db.delete(roomBots).where(eq(roomBots.roomId, roomId))
    for (const botId of input.botIds) {
      await deps.db.insert(roomBots).values({ id: newId(), roomId, botId, joinedAt: at }).onConflictDoNothing()
    }
  }
  return updated ?? existing
}

export async function hydrateRoomMessages(db: Database, rows: RoomMessageRow[]): Promise<HydratedRoomMessage[]> {
  if (rows.length === 0) return []
  const userIds = [...new Set(rows.map((r) => r.authorUserId).filter((v): v is string => Boolean(v)))]
  const botIds = [...new Set(rows.map((r) => r.authorBotId).filter((v): v is string => Boolean(v)))]
  const ticketIds = [...new Set(rows.map((r) => r.ticketId).filter((v): v is string => Boolean(v)))]

  const [userRows, botRows, ticketRows] = await Promise.all([
    userIds.length > 0 ? db.select({ id: users.id, name: users.name, avatar: users.avatar }).from(users).where(inArray(users.id, userIds)) : [],
    botIds.length > 0
      ? db.select({ id: bots.id, slug: bots.slug, name: bots.name, roleTitle: bots.roleTitle, avatar: bots.avatar }).from(bots).where(inArray(bots.id, botIds))
      : [],
    ticketIds.length > 0
      ? db.select({ id: tickets.id, shortName: tickets.shortName, stage: tickets.stage }).from(tickets).where(inArray(tickets.id, ticketIds))
      : [],
  ])

  const userMap = new Map(userRows.map((u) => [u.id, u]))
  const botMap = new Map(botRows.map((b) => [b.id, b]))
  const ticketMap = new Map(ticketRows.map((t) => [t.id, t]))

  return rows.map((row) => {
    const user = row.authorUserId ? userMap.get(row.authorUserId) : undefined
    const bot = row.authorBotId ? botMap.get(row.authorBotId) : undefined
    const ticket = row.ticketId ? ticketMap.get(row.ticketId) : undefined
    return {
      ...row,
      authorName: row.authorKind === 'bot' ? (bot?.name ?? 'Bot') : row.authorKind === 'user' ? (user?.name ?? '成员') : '系统',
      authorAvatar: row.authorKind === 'bot' ? (bot?.avatar ?? '🤖') : (user?.avatar ?? null),
      botSlug: bot?.slug ?? null,
      botRoleTitle: bot?.roleTitle ?? null,
      ticketShortName: ticket?.shortName ?? null,
      ticketStage: ticket?.stage ?? null,
    }
  })
}

export async function listRoomMessages(
  deps: Deps,
  projectId: string,
  roomId: string,
  limit = 100,
): Promise<HydratedRoomMessage[]> {
  const [room] = await deps.db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.projectId, projectId), eq(rooms.id, roomId)))
  if (!room) throw notFound('房间不存在')

  const rows = await deps.db
    .select()
    .from(roomMessages)
    .where(and(eq(roomMessages.projectId, projectId), eq(roomMessages.roomId, roomId)))
    .orderBy(desc(roomMessages.createdAt))
    .limit(Math.min(limit, 200))

  return hydrateRoomMessages(deps.db, rows.reverse())
}

export interface AppendRoomMessageInput {
  projectId: string
  roomId: string
  threadKey: string
  authorKind: 'user' | 'bot' | 'system'
  authorUserId?: string | null
  authorBotId?: string | null
  kind?: 'chat' | 'handoff' | 'status' | 'approval_card' | 'artifact' | 'report'
  content: string
  attachments?: RoomAttachment[]
  ticketId?: string | null
  turnId?: string | null
  replyToId?: string | null
  externalProvider?: string | null
  externalMessageId?: string | null
  syncToIm?: boolean
  dedupeKey?: string
  at: Date
  events?: ProjectEventBus
}

/** Persist a message into a Room, emit SSE, and optionally sync to bound IM channel. */
export async function appendRoomMessage(
  db: Database,
  input: AppendRoomMessageInput,
): Promise<HydratedRoomMessage> {
  const id = newId()
  const [inserted] = await db
    .insert(roomMessages)
    .values({
      id,
      projectId: input.projectId,
      roomId: input.roomId,
      threadKey: input.threadKey,
      authorKind: input.authorKind,
      authorUserId: input.authorUserId ?? null,
      authorBotId: input.authorBotId ?? null,
      kind: input.kind ?? 'chat',
      content: input.content.slice(0, 20_000),
      attachments: input.attachments ?? [],
      ticketId: input.ticketId ?? null,
      turnId: input.turnId ?? null,
      replyToId: input.replyToId ?? null,
      externalProvider: input.externalProvider ?? null,
      externalMessageId: input.externalMessageId ?? null,
      createdAt: input.at,
    })
    .returning()
  if (!inserted) throw new Error('appendRoomMessage returned no row')

  const [hydrated] = await hydrateRoomMessages(db, [inserted])
  const bus = input.events ?? defaultEventBus
  bus.publish(input.projectId, 'room.message', {
    roomId: input.roomId,
    message: hydrated,
  })

  if (input.syncToIm) {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, input.roomId))
    if (room?.channelId) {
      let text = input.content
      if (input.authorKind === 'bot' && input.authorBotId) {
        const [bot] = await db.select().from(bots).where(eq(bots.id, input.authorBotId))
        text = formatBotSignature(bot, text)
      }
      await db
        .insert(outboxEvents)
        .values({
          id: newId(),
          projectId: input.projectId,
          channelId: room.channelId,
          kind: input.kind ?? 'reply',
          dedupeKey: input.dedupeKey ?? `room-msg:${id}`,
          payload: { text },
          status: 'pending',
          nextAttemptAt: input.at,
          createdAt: input.at,
        })
        .onConflictDoNothing({ target: outboxEvents.dedupeKey })
    }
  }

  return hydrated!
}

/** Post a human message from the Web Room UI, triggering commands or Core Router. */
export async function postRoomMessage(
  deps: Deps & { events?: ProjectEventBus },
  projectId: string,
  roomId: string,
  actor: { id: string; name: string; isAdmin: boolean },
  input: { content: string; threadKey?: string; targetBotSlug?: string },
): Promise<{ message: HydratedRoomMessage; triggerId?: string; commandReply?: string }> {
  const access = await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'member')
  const [room] = await deps.db
    .select()
    .from(rooms)
    .where(and(eq(rooms.projectId, projectId), eq(rooms.id, roomId)))
  if (!room) throw notFound('房间不存在')

  const content = input.content.trim()
  if (!content) throw conflict('消息内容不能为空')

  const at = deps.now()
  const threadKey = input.threadKey?.trim() || `room:${room.id}`
  const message = await appendRoomMessage(deps.db, {
    projectId,
    roomId: room.id,
    threadKey,
    authorKind: 'user',
    authorUserId: actor.id,
    kind: 'chat',
    content,
    syncToIm: Boolean(room.channelId),
    dedupeKey: `web-sync:${newId()}`,
    at,
    events: deps.events,
  })

  const command = parseCommand(content)
  if (command !== null) {
    const handled = await handleCoreCommand({
      db: deps.db,
      projectId,
      channelId: room.channelId,
      threadKey,
      role: access.role,
      command,
      at,
      dedupeKey: `cmd:web:${message.id}`,
    })
    if (handled.action === 'command' && handled.reply) {
      await appendRoomMessage(deps.db, {
        projectId,
        roomId: room.id,
        threadKey,
        authorKind: 'system',
        kind: 'status',
        content: handled.reply,
        at: deps.now(),
        events: deps.events,
      })
    }
    return { message, ...(handled.reply ? { commandReply: handled.reply } : {}) }
  }

  let targetBot: BotRow | null = null
  if (input.targetBotSlug) {
    const [bySlug] = await deps.db
      .select()
      .from(bots)
      .where(and(eq(bots.projectId, projectId), eq(bots.slug, input.targetBotSlug.toLowerCase()), eq(bots.status, 'active')))
    targetBot = bySlug ?? null
  }
  if (!targetBot) {
    targetBot = await resolveMentionedBot(deps.db, projectId, content)
  }
  if (!targetBot && room.defaultBotId) {
    const [dmBot] = await deps.db
      .select()
      .from(bots)
      .where(and(eq(bots.id, room.defaultBotId), eq(bots.status, 'active')))
    targetBot = dmBot ?? null
  }

  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId))
  const trigger = await receiveCoreTrigger(deps.db, {
    projectId,
    channelId: room.channelId,
    roomId: room.id,
    targetBotId: targetBot?.id ?? null,
    provider: 'web',
    externalId: `web:${message.id}`,
    threadKey,
    actorUserId: actor.id,
    actorName: actor.name,
    text: content,
    address: room.kind === 'dm' || targetBot !== null ? 'direct' : 'mention',
    mentionedBot: true,
    authorized: project?.status === 'active',
    at,
  })

  return { message, ...(trigger.triggerId ? { triggerId: trigger.triggerId } : {}) }
}
