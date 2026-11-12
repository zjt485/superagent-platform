import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { parseBody, parseQuery, queryOf, requireUser, uuidParam } from '../../http/helpers.js'
import { requireProjectAccess } from '../../services/access.js'
import { enqueuePlan, approvePlanAndExecute, cancelTicket, retryTicket } from '../../services/orchestrator.js'
import { createTicket, getTicketById, listTickets, ticketDetail } from '../../services/tickets.js'
import { getRun, listRunEvents } from '../../services/runs.js'
import { forbidden } from '../../errors.js'
import { parsePolicy } from '../../domain/policy.js'
import { TICKET_STATUSES } from '../../domain/status.js'

const createTicketSchema = z.object({
  title: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(20_000),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  channelId: z.string().uuid().optional(),
})

const listQuerySchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const actionSchema = z.object({ comment: z.string().trim().max(2000).optional() })
const aliasCreateSchema = createTicketSchema.extend({ projectId: z.string().uuid() })


async function createForProject(
  ctx: AppContext,
  projectId: string,
  user: { id: string; name: string; isAdmin: boolean },
  body: z.infer<typeof createTicketSchema>,
) {
  const access = await requireProjectAccess(ctx, projectId, user.id, user.isAdmin, 'member')
  const policy = parsePolicy(access.project.policyJson)
  if (access.role === 'member' && !policy.membersCanCreateTickets) throw forbidden('当前项目不允许普通成员直接建单')
  if (access.project.status !== 'active') {
    throw forbidden(`项目当前为 ${access.project.status}，不能新建工单`)
  }
  const body_text = body.body.trim()
  const title = body.title?.trim() || body_text.split('\n')[0]?.slice(0, 120) || '未命名需求'
  const ticket = await createTicket(ctx, {
    projectId,
    channelId: body.channelId ?? null,
    requesterId: user.id,
    requesterName: user.name,
    title,
    body: body_text,
    priority: body.priority,
  })
  let warning: string | undefined
  try {
    await enqueuePlan(ctx, ticket)
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error)
    ctx.log.warn({ err: error, ticketId: ticket.id }, 'failed to enqueue plan for console ticket')
  }
  return { ticket: await getTicketById(ctx, ticket.id), warning }
}

export function registerTicketRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Project-scoped routes (the console uses these).
  app.get('/v1/projects/:id/tickets', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    const query = parseQuery(listQuerySchema, request)
    return await listTickets(ctx, projectId, {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { query: query.q } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
      ...(query.offset ? { offset: query.offset } : {}),
    })
  })

  app.post('/v1/projects/:id/tickets', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const body = parseBody(createTicketSchema, request)
    const result = await createForProject(ctx, projectId, user, body)
    reply.code(201)
    return result
  })

  app.get('/v1/projects/:id/tickets/:ticketId', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    return await ticketDetail(ctx, projectId, uuidParam(request, 'ticketId'))
  })

  app.post('/v1/projects/:id/tickets/:ticketId/approve', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin, 'maintainer')
    const body = parseBody(actionSchema, request)
    const ticketId = uuidParam(request, 'ticketId')
    const run = await approvePlanAndExecute(ctx, ticketId, user, body.comment)
    return { run, ticket: await getTicketById(ctx, ticketId) }
  })

  app.post('/v1/projects/:id/tickets/:ticketId/cancel', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin, 'maintainer')
    const ticket = await cancelTicket(ctx, uuidParam(request, 'ticketId'), user)
    return { ticket }
  })

  app.post('/v1/projects/:id/tickets/:ticketId/retry', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin, 'maintainer')
    const ticketId = uuidParam(request, 'ticketId')
    const run = await retryTicket(ctx, ticketId, user)
    return { run, ticket: await getTicketById(ctx, ticketId) }
  })

  // Plan-compatible aliases from §10: /v1/tickets, /v1/tickets/:id.
  app.post('/v1/tickets', async (request, reply) => {
    const user = requireUser(request)
    const body = parseBody(aliasCreateSchema, request)
    const { projectId, ...rest } = body
    const result = await createForProject(ctx, projectId, user, rest)
    reply.code(201)
    return result
  })

  app.get('/v1/tickets', async (request) => {
    const user = requireUser(request)
    const projectId = queryOf(request).projectId
    if (!projectId) throw forbidden('缺少 projectId')
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    const query = parseQuery(listQuerySchema, request)
    return await listTickets(ctx, projectId, { ...query, ...(query.q ? { query: query.q } : {}) })
  })

  app.get('/v1/tickets/:id', async (request) => {
    const user = requireUser(request)
    const ticket = await getTicketById(ctx, uuidParam(request))
    await requireProjectAccess(ctx, ticket.projectId, user.id, user.isAdmin)
    return await ticketDetail(ctx, ticket.projectId, ticket.id)
  })

  app.post('/v1/tickets/:id/approve', async (request) => {
    const user = requireUser(request)
    const ticket = await getTicketById(ctx, uuidParam(request))
    await requireProjectAccess(ctx, ticket.projectId, user.id, user.isAdmin, 'maintainer')
    const body = parseBody(actionSchema, request)
    const run = await approvePlanAndExecute(ctx, ticket.id, user, body.comment)
    return { run, ticket: await getTicketById(ctx, ticket.id) }
  })

  app.post('/v1/tickets/:id/cancel', async (request) => {
    const user = requireUser(request)
    const ticket = await getTicketById(ctx, uuidParam(request))
    await requireProjectAccess(ctx, ticket.projectId, user.id, user.isAdmin, 'maintainer')
    return { ticket: await cancelTicket(ctx, ticket.id, user) }
  })

  app.post('/v1/tickets/:id/retry', async (request) => {
    const user = requireUser(request)
    const ticket = await getTicketById(ctx, uuidParam(request))
    await requireProjectAccess(ctx, ticket.projectId, user.id, user.isAdmin, 'maintainer')
    const run = await retryTicket(ctx, ticket.id, user)
    return { run, ticket: await getTicketById(ctx, ticket.id) }
  })

  app.get('/v1/runs/:id', async (request) => {
    const user = requireUser(request)
    const run = await getRun(ctx, uuidParam(request))
    await requireProjectAccess(ctx, run.projectId, user.id, user.isAdmin)
    return { run, events: await listRunEvents(ctx, run.id) }
  })

  app.get('/v1/runs/:id/events', async (request) => {
    const user = requireUser(request)
    const run = await getRun(ctx, uuidParam(request))
    await requireProjectAccess(ctx, run.projectId, user.id, user.isAdmin)
    const limit = Number(queryOf(request).limit ?? 200)
    return { items: await listRunEvents(ctx, run.id, Number.isFinite(limit) ? limit : 200) }
  })
}


