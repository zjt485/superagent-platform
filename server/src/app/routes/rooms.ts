import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { parseBody, pathParam, queryOf, requireUser, uuidParam } from '../../http/helpers.js'
import { requireProjectAccess } from '../../services/access.js'
import { createRoom, listRoomMessages, listRooms, postRoomMessage, updateRoom } from '../../services/rooms.js'
import { defaultEventBus } from '../../services/events.js'

const createRoomSchema = z.object({
  kind: z.enum(['group', 'dm', 'routine_feed']).default('group'),
  name: z.string().trim().max(120).optional(),
  topic: z.string().max(400).nullable().optional(),
  botIds: z.array(z.string().uuid()).optional(),
  defaultBotId: z.string().uuid().nullable().optional(),
  maxHandoffHops: z.number().int().min(1).max(20).optional(),
})

const updateRoomSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  topic: z.string().max(400).nullable().optional(),
  maxHandoffHops: z.number().int().min(1).max(20).optional(),
  botIds: z.array(z.string().uuid()).optional(),
  status: z.enum(['active', 'archived']).optional(),
})

const postMessageSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  threadKey: z.string().trim().max(200).optional(),
  targetBotSlug: z.string().trim().max(40).optional(),
})

export function registerRoomRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/projects/:id/rooms', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    return { items: await listRooms(ctx, projectId, user.id) }
  })

  app.post('/v1/projects/:id/rooms', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const body = parseBody(createRoomSchema, request)
    const room = await createRoom(ctx, projectId, user, body)
    reply.code(201)
    return { room }
  })

  app.patch('/v1/projects/:id/rooms/:roomId', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const body = parseBody(updateRoomSchema, request)
    const room = await updateRoom(ctx, projectId, pathParam(request, 'roomId'), user, body)
    return { room }
  })

  app.get('/v1/projects/:id/rooms/:roomId/messages', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    const limit = z.coerce.number().int().min(1).max(200).catch(100).parse(queryOf(request).limit ?? 100)
    return { items: await listRoomMessages(ctx, projectId, pathParam(request, 'roomId'), limit) }
  })

  app.post('/v1/projects/:id/rooms/:roomId/messages', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const body = parseBody(postMessageSchema, request)
    const result = await postRoomMessage(ctx, projectId, pathParam(request, 'roomId'), user, body)
    reply.code(201)
    return result
  })

  /** Real-time Server-Sent Events stream for Rooms, Bot status, Turn logs, Approvals, and Routines. */
  app.get('/v1/projects/:id/events/stream', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    raw.write(`event: connected\ndata: ${JSON.stringify({ projectId, timestamp: new Date().toISOString() })}\n\n`)

    const bus = ctx.events ?? defaultEventBus
    const unsubscribe = bus.subscribe(projectId, (event) => {
      raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    })
    const heartbeat = setInterval(() => {
      raw.write(`: ping ${Date.now()}\n\n`)
    }, 20_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      raw.end()
    })
  })
}
