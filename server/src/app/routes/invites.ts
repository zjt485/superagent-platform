import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { parseBody, pathParam, requireUser, uuidParam } from '../../http/helpers.js'
import { requireProjectAccess } from '../../services/access.js'
import { acceptInvite, createInvite, listInvites, previewInvite, revokeInvite } from '../../services/invites.js'
import { projectBundle } from '../../services/projects.js'

const createInviteSchema = z.object({
  role: z.enum(['maintainer', 'member', 'viewer']).default('member'),
  expiresInHours: z.number().int().min(1).max(720).default(72),
  maxUses: z.number().int().min(1).max(1000).default(50),
})

export function registerInviteRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/invites/:token', async (request) => {
    const token = pathParam(request, 'token')
    return { invite: await previewInvite(ctx, token) }
  })

  app.post('/v1/invites/:token/accept', async (request, reply) => {
    const user = requireUser(request)
    const token = pathParam(request, 'token')
    const result = await acceptInvite(ctx, token, user)
    reply.code(result.alreadyMember ? 200 : 201)
    return {
      project: await projectBundle(ctx, result.projectId, user),
      role: result.role,
      alreadyMember: result.alreadyMember,
    }
  })

  app.get('/v1/projects/:id/invites', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin, 'maintainer')
    return { items: await listInvites(ctx, projectId) }
  })

  app.post('/v1/projects/:id/invites', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin, 'owner')
    const body = parseBody(createInviteSchema, request)
    const { invite, token } = await createInvite(ctx, projectId, user, body)
    reply.code(201)
    return { invite, token }
  })

  app.delete('/v1/projects/:id/invites/:inviteId', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin, 'owner')
    await revokeInvite(ctx, projectId, pathParam(request, 'inviteId'), user)
    reply.code(204)
    return null
  })
}
