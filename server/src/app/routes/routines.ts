import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { parseBody, requireUser, uuidParam } from '../../http/helpers.js'
import {
  createRoutine,
  deleteRoutine,
  listRoutines,
  triggerRoutineManual,
  updateRoutine,
} from '../../services/routines.js'

const eventFilterSchema = z.object({
  events: z.array(z.string().max(80)).max(20).optional(),
  branches: z.array(z.string().max(120)).max(20).optional(),
})

const createRoutineSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(600).nullable().optional(),
  botId: z.string().uuid().nullable().optional(),
  roomId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
  triggerType: z.enum(['cron', 'webhook', 'repo_event']).optional(),
  cronExpr: z.string().max(120).nullable().optional(),
  timezone: z.string().max(80).optional(),
  eventFilter: eventFilterSchema.optional(),
  prompt: z.string().trim().min(1).max(6000),
  notifyOnQuiet: z.boolean().optional(),
  maxBudgetUsd: z.number().min(0).max(1000).optional(),
})

const updateRoutineSchema = createRoutineSchema.partial()

export function registerRoutineRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/projects/:id/routines', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const items = await listRoutines(ctx, projectId, user)
    return { items }
  })

  app.post('/v1/projects/:id/routines', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const body = parseBody(createRoutineSchema, request)
    const routine = await createRoutine(ctx, projectId, user, {
      name: body.name,
      prompt: body.prompt,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.botId !== undefined ? { botId: body.botId } : {}),
      ...(body.roomId !== undefined ? { roomId: body.roomId } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.triggerType !== undefined ? { triggerType: body.triggerType } : {}),
      ...(body.cronExpr !== undefined ? { cronExpr: body.cronExpr } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.eventFilter !== undefined
        ? {
            eventFilter: {
              ...(body.eventFilter.events !== undefined ? { events: body.eventFilter.events } : {}),
              ...(body.eventFilter.branches !== undefined ? { branches: body.eventFilter.branches } : {}),
            },
          }
        : {}),
      ...(body.notifyOnQuiet !== undefined ? { notifyOnQuiet: body.notifyOnQuiet } : {}),
      ...(body.maxBudgetUsd !== undefined ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
    })
    reply.code(201)
    return { routine }
  })

  app.patch('/v1/projects/:id/routines/:routineId', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request, 'id')
    const routineId = uuidParam(request, 'routineId')
    const body = parseBody(updateRoutineSchema, request)
    const routine = await updateRoutine(ctx, projectId, routineId, user, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.botId !== undefined ? { botId: body.botId } : {}),
      ...(body.roomId !== undefined ? { roomId: body.roomId } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.triggerType !== undefined ? { triggerType: body.triggerType } : {}),
      ...(body.cronExpr !== undefined ? { cronExpr: body.cronExpr } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.eventFilter !== undefined
        ? {
            eventFilter: {
              ...(body.eventFilter.events !== undefined ? { events: body.eventFilter.events } : {}),
              ...(body.eventFilter.branches !== undefined ? { branches: body.eventFilter.branches } : {}),
            },
          }
        : {}),
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
      ...(body.notifyOnQuiet !== undefined ? { notifyOnQuiet: body.notifyOnQuiet } : {}),
      ...(body.maxBudgetUsd !== undefined ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
    })
    return { routine }
  })

  app.delete('/v1/projects/:id/routines/:routineId', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request, 'id')
    const routineId = uuidParam(request, 'routineId')
    await deleteRoutine(ctx, projectId, routineId, user)
    reply.code(204)
    return null
  })

  app.post('/v1/projects/:id/routines/:routineId/run', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request, 'id')
    const routineId = uuidParam(request, 'routineId')
    return triggerRoutineManual(ctx, projectId, routineId, user)
  })
}
