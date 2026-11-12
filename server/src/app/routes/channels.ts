import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { parseBody, pathParam, requireUser, uuidParam } from '../../http/helpers.js'
import { requireProjectAccess } from '../../services/access.js'
import { bindChannel, unbindChannel } from '../../services/projects.js'
import { and, desc, eq } from 'drizzle-orm'
import { channels } from '../../db/schema.js'

const bindChannelSchema = z.object({
  provider: z.enum(['feishu', 'wecom']),
  externalChatId: z.string().trim().min(1).max(200),
  name: z.string().trim().max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

export function registerChannelRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/projects/:id/channels', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    const items = await ctx.db
      .select()
      .from(channels)
      .where(eq(channels.projectId, projectId))
      .orderBy(desc(channels.createdAt))
    return { items }
  })

  app.post('/v1/projects/:id/channels', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const body = parseBody(bindChannelSchema, request)
    await bindChannel(ctx, projectId, user, body)
    const [channel] = await ctx.db
      .select()
      .from(channels)
      .where(and(eq(channels.projectId, projectId), eq(channels.status, 'active')))
    reply.code(201)
    return { channel: channel ?? null }
  })

  app.delete('/v1/projects/:id/channels/:channelId', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await unbindChannel(ctx, projectId, pathParam(request, 'channelId'), user)
    reply.code(204)
    return null
  })
}
