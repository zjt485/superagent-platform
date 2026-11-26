import { and, asc, eq, isNotNull, lte } from 'drizzle-orm'
import type { Database } from '../../db/client.js'
import { projects, rooms, routines, type RoutineRow } from '../../db/schema.js'
import { defaultEventBus, type ProjectEventBus } from '../../services/events.js'
import { receiveCoreTrigger } from '../intake.js'
import { nextCronDate } from './cron.js'

export interface TickRoutinesOptions {
  db: Database
  now: () => Date
  events?: ProjectEventBus
  limit?: number
}

export interface RunRoutineInput {
  db: Database
  routine: RoutineRow
  now: Date
  triggerKey: string
  extraContext?: string
  events?: ProjectEventBus
}

async function resolveTargetRoom(db: Database, routine: RoutineRow) {
  if (routine.roomId) {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, routine.roomId))
    if (room) return room
  }
  const [fallback] = await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.projectId, routine.projectId), eq(rooms.status, 'active')))
    .orderBy(asc(rooms.createdAt))
    .limit(1)
  return fallback ?? null
}

/**
 * Enqueue a single routine run as an idempotent Core `routine` trigger.
 * Used by the cron scheduler, repository event hooks, and manual "试跑" button.
 */
export async function runRoutineNow(input: RunRoutineInput): Promise<{ triggerId: string; deduplicated: boolean }> {
  const { db, routine, now, triggerKey, extraContext } = input
  const [project] = await db.select().from(projects).where(eq(projects.id, routine.projectId))
  if (!project || project.status !== 'active') {
    return { triggerId: '', deduplicated: true }
  }
  const room = await resolveTargetRoom(db, routine)
  const promptLines = [
    `[定时/事件巡检：${routine.name}]`,
    routine.prompt,
    ...(extraContext ? ['', `触发上下文：\n${extraContext}`] : []),
    '',
    routine.notifyOnQuiet
      ? '完成后请汇报本次巡检结果。'
      : '若巡检一切正常无异常，请在总结中明确标注「一切正常」，平台将静默归档不打扰群成员；若发现异常或风险，请详细汇报。',
  ]
  const text = promptLines.join('\n')
  const externalId = `routine:${routine.id}:${triggerKey}`
  const result = await receiveCoreTrigger(db, {
    projectId: routine.projectId,
    channelId: room?.channelId ?? null,
    roomId: room?.id ?? null,
    provider: 'routine',
    externalId,
    kind: 'routine',
    threadKey: `routine:${routine.id}:${triggerKey.slice(0, 24)}`,
    actorName: `Routine · ${routine.name}`,
    text,
    address: 'direct',
    isBot: true,
    mentionedBot: true,
    targetBotId: routine.botId,
    raw: {
      routineId: routine.id,
      routineName: routine.name,
      notifyOnQuiet: routine.notifyOnQuiet,
      maxBudgetUsd: routine.maxBudgetUsd,
    },
    authorized: true,
    at: now,
  })

  const deduplicated = result.action !== 'queued'
  const triggerId = result.triggerId ?? ''
  if (!deduplicated && triggerId) {
    const bus = input.events ?? defaultEventBus
    bus.publish(routine.projectId, 'routine.run', {
      routineId: routine.id,
      name: routine.name,
      triggerId,
      botId: routine.botId,
      roomId: room?.id ?? null,
      at: now.toISOString(),
    })
  }
  return { triggerId, deduplicated }
}

/**
 * Claim all due enabled Cron routines (`next_run_at <= now`) using
 * `FOR UPDATE SKIP LOCKED`, advance their `next_run_at`, and emit idempotent
 * `routine` triggers into the unified Core pipeline.
 */
export async function tickRoutines(options: TickRoutinesOptions): Promise<{ triggered: number }> {
  const at = options.now()
  const limit = options.limit ?? 20

  const claimed = await options.db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(routines)
      .where(
        and(
          eq(routines.enabled, true),
          eq(routines.triggerType, 'cron'),
          isNotNull(routines.nextRunAt),
          lte(routines.nextRunAt, at),
        ),
      )
      .orderBy(asc(routines.nextRunAt))
      .limit(limit)
      .for('update', { skipLocked: true })

    const picked: Array<{ routine: RoutineRow; slotKey: string }> = []
    for (const routine of due) {
      let nextRun: Date | null = null
      if (routine.cronExpr) {
        try {
          nextRun = nextCronDate(routine.cronExpr, at, routine.timezone || 'Asia/Shanghai')
        } catch {
          nextRun = null
        }
      }
      const slotKey = (routine.nextRunAt ?? at).toISOString().slice(0, 16)
      await tx
        .update(routines)
        .set({
          nextRunAt: nextRun,
          lastRunAt: at,
          lastStatus: 'queued',
          updatedAt: at,
        })
        .where(eq(routines.id, routine.id))
      picked.push({ routine, slotKey })
    }
    return picked
  })

  let triggered = 0
  for (const item of claimed) {
    const res = await runRoutineNow({
      db: options.db,
      routine: item.routine,
      now: at,
      triggerKey: item.slotKey,
      ...(options.events ? { events: options.events } : {}),
    })
    if (!res.deduplicated && res.triggerId) triggered += 1
  }
  return { triggered }
}

/**
 * Trigger enabled `repo_event` or `webhook` routines matching an incoming
 * GitHub/external event (e.g. `push`, `pull_request`, `check_run`).
 */
export async function triggerEventRoutines(input: {
  db: Database
  projectId: string
  triggerType: 'repo_event' | 'webhook'
  eventType: string
  branch?: string | null
  deliveryId: string
  summary: string
  now: Date
  events?: ProjectEventBus
}): Promise<{ triggered: number }> {
  const candidates = await input.db
    .select()
    .from(routines)
    .where(
      and(
        eq(routines.projectId, input.projectId),
        eq(routines.enabled, true),
        eq(routines.triggerType, input.triggerType),
      ),
    )

  let triggered = 0
  for (const routine of candidates) {
    const filter = routine.eventFilter ?? {}
    if (Array.isArray(filter.events) && filter.events.length > 0 && !filter.events.includes(input.eventType)) {
      continue
    }
    if (
      Array.isArray(filter.branches) &&
      filter.branches.length > 0 &&
      input.branch &&
      !filter.branches.includes(input.branch)
    ) {
      continue
    }
    await input.db
      .update(routines)
      .set({ lastRunAt: input.now, lastStatus: 'queued', updatedAt: input.now })
      .where(eq(routines.id, routine.id))
    const res = await runRoutineNow({
      db: input.db,
      routine,
      now: input.now,
      triggerKey: `evt-${input.deliveryId}`,
      extraContext: `事件：${input.eventType}${input.branch ? `（分支 ${input.branch}）` : ''}\n${input.summary}`,
      ...(input.events ? { events: input.events } : {}),
    })
    if (!res.deduplicated && res.triggerId) triggered += 1
  }
  return { triggered }
}
