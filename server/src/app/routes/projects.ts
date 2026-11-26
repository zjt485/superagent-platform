import { and, count, desc, eq, ilike, inArray, or } from 'drizzle-orm'
import { projectMembers } from '../../db/schema.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { parseBody, parseQuery, pathParam, queryOf, requireUser, uuidParam } from '../../http/helpers.js'
import {
  addMemberByIdentity,
  addMemberByUserId,
  changeMemberRole,
  createProject,
  listMembers,
  listProjects,
  projectBundle,
  removeMember,
  updateProject,
} from '../../services/projects.js'
import { getProjectRow, requireProjectAccess } from '../../services/access.js'
import { listAudit } from '../../services/audit.js'
import { tokensUsedToday, usageSeries } from '../../services/usage.js'
import { decisions, evaluations, tickets, users } from '../../db/schema.js'
import { parsePolicy } from '../../domain/policy.js'
import { overviewCounts, mainSessionView, turnToRun } from '../../core/views.js'
import { notifyPolicyChanged } from '../../core/operations.js'
import { policyVersion } from '../../core/policy.js'

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().max(48).optional(),
  description: z.string().max(2000).optional(),
  policy: z.unknown().optional(),
  modelConfig: z.unknown().optional(),
})

const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(2000).nullable().optional(),
    policy: z.unknown().optional(),
    modelConfig: z.unknown().optional(),
    status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '没有需要更新的字段' })

const memberRoleSchema = z.enum(['maintainer', 'member', 'viewer'])

const addMemberSchema = z
  .object({
    userId: z.string().uuid().optional(),
    provider: z.enum(['feishu', 'wecom']).optional(),
    externalId: z.string().min(1).max(200).optional(),
    role: memberRoleSchema.default('member'),
  })
  .refine((value) => Boolean(value.userId) !== Boolean(value.provider && value.externalId), {
    message: '需要提供 userId，或 provider + externalId',
  })

const routerRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

const auditQuerySchema = z.object({
  action: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/projects', async (request) => {
    const user = requireUser(request)
    return { items: await listProjects(ctx, user) }
  })

  app.post('/v1/projects', async (request, reply) => {
    const user = requireUser(request)
    const body = parseBody(createProjectSchema, request)
    const project = await createProject(ctx, user, body)
    reply.code(201)
    return { project: await projectBundle(ctx, project.id, user) }
  })

  app.get('/v1/projects/:id', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    return { project: await projectBundle(ctx, projectId, user) }
  })

  /** Router runs replace the Main Session view for the core engine. */
  app.get('/v1/projects/:id/router-runs', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    const query = parseQuery(routerRunsQuerySchema, request)
    const runs = await ctx.db
      .select()
      .from(evaluations)
      .where(eq(evaluations.projectId, projectId))
      .orderBy(desc(evaluations.createdAt))
      .limit(query.limit ?? 30)
    const ids = runs.map((run) => run.id)
    const rows =
      ids.length === 0
        ? []
        : await ctx.db.select().from(decisions).where(inArray(decisions.runId, ids))
    const byRun = new Map<string, typeof rows>()
    for (const row of rows) {
      const list = byRun.get(row.runId) ?? []
      list.push(row)
      byRun.set(row.runId, list)
    }
    return { items: runs.map((run) => ({ ...run, decisions: byRun.get(run.id) ?? [] })) }
  })

  app.patch('/v1/projects/:id', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const body = parseBody(updateProjectSchema, request)
    const before = await getProjectRow(ctx, projectId)
    const beforeVersion = policyVersion(parsePolicy(before.policyJson))
    await updateProject(ctx, projectId, user, body)
    if (body.policy !== undefined) {
      const after = await getProjectRow(ctx, projectId)
      const afterVersion = policyVersion(parsePolicy(after.policyJson))
      await notifyPolicyChanged(ctx, after, beforeVersion, afterVersion)
    }
    return { project: await projectBundle(ctx, projectId, user) }
  })

  app.get('/v1/projects/:id/members', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    return { items: await listMembers(ctx, projectId) }
  })

  app.post('/v1/projects/:id/members', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const body = parseBody(addMemberSchema, request)
    if (body.userId) {
      await addMemberByUserId(ctx, projectId, user, { userId: body.userId, role: body.role })
    } else {
      await addMemberByIdentity(ctx, projectId, user, {
        provider: body.provider as string,
        externalId: body.externalId as string,
        role: body.role,
      })
    }
    reply.code(201)
    return { items: await listMembers(ctx, projectId) }
  })

  app.patch('/v1/projects/:id/members/:userId', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const userId = pathParam(request, 'userId')
    const body = parseBody(z.object({ role: z.enum(['owner', 'maintainer', 'member', 'viewer']) }), request)
    await changeMemberRole(ctx, projectId, user, userId, body.role)
    return { items: await listMembers(ctx, projectId) }
  })

  app.delete('/v1/projects/:id/members/:userId', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await removeMember(ctx, projectId, user, pathParam(request, 'userId'))
    reply.code(204)
    return null
  })

  app.get('/v1/projects/:id/overview', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const access = await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    const stats = await overviewCounts(ctx, projectId)
    const recentTickets = await ctx.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId))
      .orderBy(desc(tickets.createdAt))
      .limit(8)
    const runtime: Record<string, number> = {}
    for (const [key, value] of Object.entries(stats.turns)) {
      const [kind, status] = key.split(':')
      if (kind === 'execute' && status) runtime[status] = (runtime[status] ?? 0) + value
    }
    const todayTokens = await tokensUsedToday(ctx, projectId)
    return {
      project: await projectBundle(ctx, projectId, user),
      tickets: stats.tickets,
      runs: runtime,
      recentTickets,
      activeRuns: stats.activeTurns.map(turnToRun),
      todayTokens,
      policy: parsePolicy(access.project.policyJson),
    }
  })

  app.get('/v1/projects/:id/main-session', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    return await mainSessionView(ctx, projectId)
  })

  app.get('/v1/projects/:id/audit', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin, 'maintainer')
    const query = parseQuery(auditQuerySchema, request)
    const items = await listAudit(ctx, {
      projectId,
      ...(query.action ? { action: query.action } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
      ...(query.offset ? { offset: query.offset } : {}),
    })
    return { items }
  })

  app.get('/v1/projects/:id/usage', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const access = await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    const days = z.coerce.number().int().min(1).max(90).catch(30).parse(queryOf(request).days ?? 30)
    const series = await usageSeries(ctx, projectId, days)
    return {
      series,
      todayTokens: await tokensUsedToday(ctx, projectId),
      policy: parsePolicy(access.project.policyJson),
    }
  })

  // A deliberately narrow lookup: only users who already share a project with
  // the requester can be found (admins may search everyone).
  app.get('/v1/users', async (request) => {
    const user = requireUser(request)
    const query = queryOf(request).q?.trim() ?? ''
    if (!query) return { items: [] }
    const pattern = `%${query.slice(0, 80)}%`
    const match = or(ilike(users.name, pattern), ilike(users.email, pattern))
    if (user.isAdmin) {
      const rows = await ctx.db
        .select({ id: users.id, name: users.name, email: users.email, avatar: users.avatar })
        .from(users)
        .where(match)
        .limit(20)
      return { items: rows }
    }
    const mine = await ctx.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, user.id))
    if (mine.length === 0) return { items: [] }
    const rows = await ctx.db
      .selectDistinct({ id: users.id, name: users.name, email: users.email, avatar: users.avatar })
      .from(users)
      .innerJoin(projectMembers, eq(projectMembers.userId, users.id))
      .where(and(inArray(projectMembers.projectId, mine.map((row) => row.projectId)), match))
      .limit(20)
    return { items: rows }
  })
}
