import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { pathParam, requireUser, uuidParam } from '../../http/helpers.js'
import { requireProjectAccess } from '../../services/access.js'
import {
  acceptJoinLink,
  createManagedWecomGroup,
  getJoinLink,
  previewJoinLink,
} from '../../services/wecom-join.js'

export function registerJoinRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Creates the app-managed WeCom group for a project that already has a repo,
   * binds it as the project's channel, and returns the stable scan QR.
   */
  app.post('/v1/projects/:id/wecom-group', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const setup = await createManagedWecomGroup(ctx, projectId, user)
    reply.code(201)
    return {
      project: setup.project,
      channel: setup.channel,
      group: setup.group,
      join: setup.join,
    }
  })

  app.get('/v1/projects/:id/join-link', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin, 'maintainer')
    return await getJoinLink(ctx, projectId, user)
  })

  app.get('/v1/join/:token', async (request) => {
    return await previewJoinLink(ctx, pathParam(request, 'token'))
  })

  app.post('/v1/join/:token/accept', async (request, reply) => {
    const user = requireUser(request)
    const result = await acceptJoinLink(ctx, pathParam(request, 'token'), user)
    reply.code(201)
    return result
  })
}
