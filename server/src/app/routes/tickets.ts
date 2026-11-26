import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { parseBody, parseQuery, queryOf, requireUser, uuidParam } from '../../http/helpers.js'
import { requireProjectAccess } from '../../services/access.js'
import { approveTicketPlan, createConsoleTicket, retryCoreTicket, stopCoreTicket } from '../../core/operations.js'
import { listTicketsView, ticketDetailView, runDetailView } from '../../core/views.js'
import { channels, tickets } from '../../db/schema.js'
import { and, eq } from 'drizzle-orm'
import { forbidden, notFound } from '../../errors.js'
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
  stage: z.string().trim().max(40).optional(),
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
  if (access.project.status !== 'active') throw forbidden(`项目当前为 ${access.project.status}，不能新建工单`)
  const [channel] = body.channelId
    ? await ctx.db
        .select()
        .from(channels)
        .where(and(eq(channels.id, body.channelId), eq(channels.projectId, projectId)))
        .limit(1)
    : await ctx.db
        .select()
        .from(channels)
        .where(and(eq(channels.projectId, projectId), eq(channels.status, 'active')))
        .limit(1)
  const bodyText = body.body.trim()
  const title = body.title?.trim() || bodyText.split('\n')[0]?.slice(0, 120) || '未命名需求'
  const { ticket, turnId } = await createConsoleTicket(ctx, {
    project: access.project,
    channel: channel ?? null,
    actor: { id: user.id, name: user.name },
    title,
    body: bodyText,
    scope: `完成「${title}」并提交可评审的改动，不得修改项目策略或权限。`,
    priority: body.priority,
  })
  return { ticket, turnId, ...(turnId ? {} : { warning: '工单已创建，但未排入 Executor：项目预算或状态不允许启动新的 Run。' }) }
}

async function ticketForAccess(ctx: AppContext, ticketId: string) {
  const [ticket] = await ctx.db.select().from(tickets).where(eq(tickets.id, ticketId))
  if (!ticket) throw notFound('工单不存在')
  return ticket
}

export function registerTicketRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/projects/:id/tickets', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    const query = parseQuery(listQuerySchema, request)
    return await listTicketsView(ctx, projectId, {
      ...(query.status ? { status: query.status } : {}),
      ...(query.stage ? { stage: query.stage } : {}),
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
    return await ticketDetailView(ctx, projectId, uuidParam(request, 'ticketId'))
  })

  app.post('/v1/projects/:id/tickets/:ticketId/approve', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin, 'maintainer')
    const body = parseBody(actionSchema, request)
    const ticketId = uuidParam(request, 'ticketId')
    const ticket = await approveTicketPlan(ctx, projectId, ticketId, user, body.comment)
    return { ticket }
  })

  app.post('/v1/projects/:id/tickets/:ticketId/cancel', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin, 'maintainer')
    const ticket = await stopCoreTicket(ctx, projectId, uuidParam(request, 'ticketId'), user, 'console')
    return { ticket }
  })

  app.post('/v1/projects/:id/tickets/:ticketId/retry', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin, 'maintainer')
    const ticket = await retryCoreTicket(ctx, projectId, uuidParam(request, 'ticketId'), user)
    return { ticket }
  })

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
    return await listTicketsView(ctx, projectId, { ...query, ...(query.q ? { query: query.q } : {}) })
  })

  app.get('/v1/tickets/:id', async (request) => {
    const user = requireUser(request)
    const ticket = await ticketForAccess(ctx, uuidParam(request))
    await requireProjectAccess(ctx, ticket.projectId, user.id, user.isAdmin)
    return await ticketDetailView(ctx, ticket.projectId, ticket.id)
  })

  app.post('/v1/tickets/:id/approve', async (request) => {
    const user = requireUser(request)
    const ticket = await ticketForAccess(ctx, uuidParam(request))
    await requireProjectAccess(ctx, ticket.projectId, user.id, user.isAdmin, 'maintainer')
    const body = parseBody(actionSchema, request)
    return { ticket: await approveTicketPlan(ctx, ticket.projectId, ticket.id, user, body.comment) }
  })

  app.post('/v1/tickets/:id/cancel', async (request) => {
    const user = requireUser(request)
    const ticket = await ticketForAccess(ctx, uuidParam(request))
    await requireProjectAccess(ctx, ticket.projectId, user.id, user.isAdmin, 'maintainer')
    return { ticket: await stopCoreTicket(ctx, ticket.projectId, ticket.id, user, 'console') }
  })

  app.post('/v1/tickets/:id/retry', async (request) => {
    const user = requireUser(request)
    const ticket = await ticketForAccess(ctx, uuidParam(request))
    await requireProjectAccess(ctx, ticket.projectId, user.id, user.isAdmin, 'maintainer')
    return { ticket: await retryCoreTicket(ctx, ticket.projectId, ticket.id, user) }
  })

  app.get('/v1/runs/:id', async (request) => {
    const user = requireUser(request)
    const result = await runDetailView(ctx, uuidParam(request))
    await requireProjectAccess(ctx, result.run.projectId, user.id, user.isAdmin)
    return result
  })

  app.get('/v1/runs/:id/events', async (request) => {
    const user = requireUser(request)
    const result = await runDetailView(ctx, uuidParam(request))
    await requireProjectAccess(ctx, result.run.projectId, user.id, user.isAdmin)
    return { items: result.events }
  })
}
