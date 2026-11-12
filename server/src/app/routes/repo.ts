import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { parseBody, queryOf, requireUser, uuidParam } from '../../http/helpers.js'
import { requireProjectAccess } from '../../services/access.js'
import { bindRepo, listInstallations, recordInstallation, unbindRepo } from '../../services/projects.js'
import { repos } from '../../db/schema.js'
import { signValue, verifyValue } from '../../security/tokens.js'
import { AppError, badRequest, conflict } from '../../errors.js'

const bindRepoSchema = z.object({
  installationId: z.string().min(1).max(40),
  owner: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  defaultBranch: z.string().trim().min(1).max(100).optional(),
  private: z.boolean().optional(),
})

const installStateSchema = z.object({ projectId: z.string().uuid(), userId: z.string().uuid(), exp: z.number() })

export function registerRepoRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/projects/:id/repo', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    const [repo] = await ctx.db.select().from(repos).where(eq(repos.projectId, projectId))
    return { repo: repo ?? null, installations: await listInstallations(ctx, projectId), mode: ctx.github.mode }
  })

  app.post('/v1/projects/:id/repo', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const body = parseBody(bindRepoSchema, request)
    if (ctx.github.mode === 'app') {
      const info = await ctx.github.repoInfo(body.installationId, body.owner, body.name)
      await bindRepo(ctx, projectId, user, {
        installationId: body.installationId,
        owner: info.owner,
        name: info.name,
        defaultBranch: body.defaultBranch ?? info.defaultBranch,
        private: body.private ?? info.private,
      })
    } else {
      await bindRepo(ctx, projectId, user, {
        installationId: body.installationId,
        owner: body.owner,
        name: body.name,
        ...(body.defaultBranch ? { defaultBranch: body.defaultBranch } : {}),
        ...(body.private === undefined ? {} : { private: body.private }),
      })
    }
    const [repo] = await ctx.db.select().from(repos).where(eq(repos.projectId, projectId))
    return { repo: repo ?? null }
  })

  app.delete('/v1/projects/:id/repo', async (request, reply) => {
    const user = requireUser(request)
    await unbindRepo(ctx, uuidParam(request), user)
    reply.code(204)
    return null
  })

  app.get('/v1/projects/:id/repo/candidates', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin, 'owner')
    const query = queryOf(request)
    let installationId = query.installationId
    if (!installationId) {
      const installations = await listInstallations(ctx, projectId)
      installationId = installations[0]?.installationId
    }
    if (!installationId) throw conflict('请先安装 GitHub App 并授权仓库')
    const items = await ctx.github.installationRepos(installationId)
    return { items, mode: ctx.github.mode }
  })

  app.get('/v1/github/install/start', async (request, reply) => {
    const user = requireUser(request)
    const projectId = queryOf(request).projectId
    if (!projectId) throw badRequest('缺少 projectId')
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin, 'owner')
    const state = signValue(ctx.config.SESSION_SECRET, {
      projectId,
      userId: user.id,
      exp: Date.now() + 10 * 60_000,
    })
    return reply.redirect(ctx.github.installUrl(state))
  })

  app.get('/v1/github/install/callback', async (request, reply) => {
    if (!request.user) return reply.redirect('/login?next=/projects')
    const query = queryOf(request)
    const installationId = query.installation_id
    const state = query.state
    if (!installationId || !state) throw badRequest('安装回调缺少参数')
    const parsed = verifyValue<{ projectId?: string; userId?: string; exp?: number }>(ctx.config.SESSION_SECRET, state)
    if (!parsed?.projectId || !parsed.exp || parsed.exp < Date.now()) throw badRequest('安装状态已过期，请重新安装')
    if (parsed.userId !== request.user.id) throw new AppError(403, 'forbidden', '安装状态与当前用户不匹配')
    await requireProjectAccess(ctx, parsed.projectId, request.user.id, request.user.isAdmin, 'owner')
    const account = await ctx.github
      .installationAccount(installationId)
      .catch(() => ({ login: 'unknown', type: 'Organization' }))
    await recordInstallation(ctx, parsed.projectId, {
      installationId,
      accountLogin: account.login,
      accountType: account.type,
    })
    return reply.redirect(`/projects/${parsed.projectId}?installed=1`)
  })

}
