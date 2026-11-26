import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { parseBody, pathParam, queryOf, requireUser, uuidParam } from '../../http/helpers.js'
import { requireProjectAccess } from '../../services/access.js'
import { decideActionApproval, listActionApprovals } from '../../services/approvals.js'

const decideSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'revision_requested']),
  comment: z.string().trim().max(2000).optional(),
})

const statusSchema = z.enum(['pending', 'approved', 'rejected', 'revision_requested', 'expired']).optional()

export function registerApprovalRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/projects/:id/approvals', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    const status = statusSchema.catch(undefined).parse(queryOf(request).status)
    return { items: await listActionApprovals(ctx, projectId, status) }
  })

  app.post('/v1/projects/:id/approvals/:approvalId/decide', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const body = parseBody(decideSchema, request)
    return decideActionApproval(ctx, projectId, pathParam(request, 'approvalId'), user, body)
  })
}
