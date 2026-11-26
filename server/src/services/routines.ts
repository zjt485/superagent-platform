import { and, desc, eq } from 'drizzle-orm'
import { bots, rooms, routines, type RoutineEventFilter, type RoutineRow } from '../db/schema.js'
import { newId } from '../domain/ids.js'
import { badRequest, notFound } from '../errors.js'
import { nextCronDate, parseCronExpression } from '../core/routines/cron.js'
import { runRoutineNow } from '../core/routines/scheduler.js'
import { requireProjectAccess } from './access.js'
import { audit } from './audit.js'
import type { Deps } from './deps.js'

export interface Actor {
  id: string
  isAdmin: boolean
}

export interface CreateRoutineInput {
  name: string
  description?: string | null
  botId?: string | null
  roomId?: string | null
  enabled?: boolean
  triggerType?: 'cron' | 'webhook' | 'repo_event'
  cronExpr?: string | null
  timezone?: string
  eventFilter?: RoutineEventFilter
  prompt: string
  notifyOnQuiet?: boolean
  maxBudgetUsd?: number
}

export interface UpdateRoutineInput extends Partial<CreateRoutineInput> {}

export interface RoutineView extends RoutineRow {
  botName: string | null
  botSlug: string | null
  botAvatar: string | null
  roomName: string | null
}

function validateSchedule(triggerType: 'cron' | 'webhook' | 'repo_event', cronExpr: string | null | undefined, timezone: string, now: Date, enabled: boolean): Date | null {
  if (triggerType !== 'cron') return null
  const expr = cronExpr?.trim() ?? ''
  if (!expr) throw badRequest('Cron 类型的 Routine 必须提供 cronExpr（5 段标准表达式）')
  try {
    parseCronExpression(expr)
    return enabled ? nextCronDate(expr, now, timezone) : null
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'Cron 表达式不合法')
  }
}

async function hydrateRoutines(deps: Deps, projectId: string, rows: RoutineRow[]): Promise<RoutineView[]> {
  if (rows.length === 0) return []
  const projectBots = await deps.db.select().from(bots).where(eq(bots.projectId, projectId))
  const projectRooms = await deps.db.select().from(rooms).where(eq(rooms.projectId, projectId))
  const botMap = new Map(projectBots.map((b) => [b.id, b]))
  const roomMap = new Map(projectRooms.map((r) => [r.id, r]))
  return rows.map((row) => {
    const bot = row.botId ? botMap.get(row.botId) : null
    const room = row.roomId ? roomMap.get(row.roomId) : null
    return {
      ...row,
      botName: bot?.name ?? null,
      botSlug: bot?.slug ?? null,
      botAvatar: bot?.avatar ?? null,
      roomName: room?.name ?? null,
    }
  })
}

export async function listRoutines(deps: Deps, projectId: string, actor: Actor): Promise<RoutineView[]> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'viewer')
  const rows = await deps.db
    .select()
    .from(routines)
    .where(eq(routines.projectId, projectId))
    .orderBy(desc(routines.createdAt))
  return hydrateRoutines(deps, projectId, rows)
}

export async function createRoutine(
  deps: Deps,
  projectId: string,
  actor: Actor,
  input: CreateRoutineInput,
): Promise<RoutineView> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'maintainer')
  const at = deps.now()
  const triggerType = input.triggerType ?? 'cron'
  const timezone = input.timezone?.trim() || 'Asia/Shanghai'
  const enabled = input.enabled ?? true
  const nextRunAt = validateSchedule(triggerType, input.cronExpr, timezone, at, enabled)

  if (input.botId) {
    const [bot] = await deps.db
      .select({ id: bots.id })
      .from(bots)
      .where(and(eq(bots.id, input.botId), eq(bots.projectId, projectId)))
    if (!bot) throw badRequest('指定的 Bot 不属于当前项目')
  }
  if (input.roomId) {
    const [room] = await deps.db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.id, input.roomId), eq(rooms.projectId, projectId)))
    if (!room) throw badRequest('指定的协作房间不属于当前项目')
  }

  const [created] = await deps.db
    .insert(routines)
    .values({
      id: newId(),
      projectId,
      botId: input.botId ?? null,
      roomId: input.roomId ?? null,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      enabled,
      triggerType,
      cronExpr: triggerType === 'cron' ? input.cronExpr?.trim() ?? null : null,
      timezone,
      eventFilter: input.eventFilter ?? {},
      prompt: input.prompt.trim(),
      notifyOnQuiet: input.notifyOnQuiet ?? false,
      maxBudgetUsd: input.maxBudgetUsd ?? 1,
      nextRunAt,
      lastRunAt: null,
      lastStatus: null,
      lastTicketId: null,
      createdAt: at,
      updatedAt: at,
    })
    .returning()

  await audit(deps, {
    projectId,
    actorId: actor.id,
    action: 'routine.create',
    target: `routine:${created!.id}`,
    metadata: { name: created!.name, triggerType, cronExpr: created!.cronExpr },
  })
  const [hydrated] = await hydrateRoutines(deps, projectId, [created!])
  return hydrated!
}

export async function updateRoutine(
  deps: Deps,
  projectId: string,
  routineId: string,
  actor: Actor,
  patch: UpdateRoutineInput,
): Promise<RoutineView> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'maintainer')
  const [existing] = await deps.db
    .select()
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.projectId, projectId)))
  if (!existing) throw notFound('定时巡检任务不存在')

  const at = deps.now()
  const triggerType = patch.triggerType ?? existing.triggerType
  const timezone = patch.timezone !== undefined ? patch.timezone.trim() || 'Asia/Shanghai' : existing.timezone
  const enabled = patch.enabled ?? existing.enabled
  const cronExpr = patch.cronExpr !== undefined ? patch.cronExpr : existing.cronExpr
  const nextRunAt = validateSchedule(triggerType, cronExpr, timezone, at, enabled)

  const [updated] = await deps.db
    .update(routines)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
      ...(patch.botId !== undefined ? { botId: patch.botId } : {}),
      ...(patch.roomId !== undefined ? { roomId: patch.roomId } : {}),
      enabled,
      triggerType,
      cronExpr: triggerType === 'cron' ? cronExpr?.trim() ?? null : null,
      timezone,
      ...(patch.eventFilter !== undefined ? { eventFilter: patch.eventFilter } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() } : {}),
      ...(patch.notifyOnQuiet !== undefined ? { notifyOnQuiet: patch.notifyOnQuiet } : {}),
      ...(patch.maxBudgetUsd !== undefined ? { maxBudgetUsd: patch.maxBudgetUsd } : {}),
      nextRunAt,
      updatedAt: at,
    })
    .where(eq(routines.id, routineId))
    .returning()

  await audit(deps, {
    projectId,
    actorId: actor.id,
    action: 'routine.update',
    target: `routine:${routineId}`,
    metadata: { name: updated!.name, enabled: updated!.enabled },
  })
  const [hydrated] = await hydrateRoutines(deps, projectId, [updated!])
  return hydrated!
}

export async function deleteRoutine(
  deps: Deps,
  projectId: string,
  routineId: string,
  actor: Actor,
): Promise<void> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'maintainer')
  const [existing] = await deps.db
    .select({ id: routines.id, name: routines.name })
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.projectId, projectId)))
  if (!existing) throw notFound('定时巡检任务不存在')
  await deps.db.delete(routines).where(eq(routines.id, routineId))
  await audit(deps, {
    projectId,
    actorId: actor.id,
    action: 'routine.delete',
    target: `routine:${routineId}`,
    metadata: { name: existing.name },
  })
}

export async function triggerRoutineManual(
  deps: Deps,
  projectId: string,
  routineId: string,
  actor: Actor,
): Promise<{ triggerId: string; routine: RoutineView }> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'maintainer')
  const [routine] = await deps.db
    .select()
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.projectId, projectId)))
  if (!routine) throw notFound('定时巡检任务不存在')

  const at = deps.now()
  const [updated] = await deps.db
    .update(routines)
    .set({ lastRunAt: at, lastStatus: 'queued', updatedAt: at })
    .where(eq(routines.id, routineId))
    .returning()

  const res = await runRoutineNow({
    db: deps.db,
    routine: updated!,
    now: at,
    triggerKey: `manual-${at.getTime()}-${newId().slice(0, 6)}`,
    ...(deps.events ? { events: deps.events } : {}),
  })
  await audit(deps, {
    projectId,
    actorId: actor.id,
    action: 'routine.manual_run',
    target: `routine:${routineId}`,
    metadata: { triggerId: res.triggerId },
  })
  const [hydrated] = await hydrateRoutines(deps, projectId, [updated!])
  return { triggerId: res.triggerId, routine: hydrated! }
}
