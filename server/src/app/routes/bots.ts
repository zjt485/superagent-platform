import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { parseBody, pathParam, requireUser, uuidParam } from '../../http/helpers.js'
import { requireProjectAccess } from '../../services/access.js'
import { createBot, getBot, installRdBotTemplates, listBots, updateBot } from '../../services/bots.js'

const modelConfigSchema = z
  .object({
    baseUrl: z.string().url().optional(),
    apiKeyRef: z.string().max(120).optional(),
    model: z.string().min(1).max(120).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().min(256).max(65536).optional(),
    maxSteps: z.number().int().min(1).max(100).optional(),
  })
  .optional()

const toolPolicySchema = z
  .object({
    allowedTools: z.array(z.string().min(1).max(120)).optional(),
    mcpServerIds: z.array(z.string().uuid()).optional(),
    rules: z.record(z.string(), z.enum(['allow', 'confirm', 'deny'])).optional(),
  })
  .optional()

const sandboxConfigSchema = z
  .object({
    mode: z.enum(['local', 'docker']).optional(),
    image: z.string().max(200).optional(),
    memoryMb: z.number().int().min(256).max(16384).optional(),
    cpus: z.number().min(0.25).max(8).optional(),
    browserEnabled: z.boolean().optional(),
    networkMode: z.enum(['none', 'bridge']).optional(),
  })
  .optional()

const imBindingSchema = z
  .object({
    provider: z.enum(['feishu', 'wecom']).optional(),
    botId: z.string().max(200).optional(),
    appId: z.string().max(200).optional(),
    secretRef: z.string().max(200).optional(),
  })
  .nullable()
  .optional()

const createBotSchema = z.object({
  slug: z.string().trim().max(40).optional(),
  name: z.string().trim().min(1).max(80),
  roleTitle: z.string().trim().min(1).max(120),
  avatar: z.string().max(32).nullable().optional(),
  systemPrompt: z.string().max(20_000).optional(),
  modelConfig: modelConfigSchema,
  toolPolicy: toolPolicySchema,
  sandboxConfig: sandboxConfigSchema,
  imBinding: imBindingSchema,
})

const updateBotSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  roleTitle: z.string().trim().min(1).max(120).optional(),
  avatar: z.string().max(32).nullable().optional(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
  systemPrompt: z.string().max(20_000).optional(),
  modelConfig: modelConfigSchema,
  toolPolicy: toolPolicySchema,
  sandboxConfig: sandboxConfigSchema,
  imBinding: imBindingSchema,
})

export function registerBotRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/projects/:id/bots', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    return { items: await listBots(ctx, projectId) }
  })

  app.post('/v1/projects/:id/bots', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const body = parseBody(createBotSchema, request)
    const bot = await createBot(ctx, projectId, user, body)
    reply.code(201)
    return { bot }
  })

  app.post('/v1/projects/:id/bots/templates/rd', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const result = await installRdBotTemplates(ctx, projectId, user)
    reply.code(201)
    return result
  })

  app.get('/v1/projects/:id/bots/:botId', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    await requireProjectAccess(ctx, projectId, user.id, user.isAdmin)
    return { bot: await getBot(ctx, projectId, pathParam(request, 'botId')) }
  })

  app.patch('/v1/projects/:id/bots/:botId', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const body = parseBody(updateBotSchema, request)
    const bot = await updateBot(ctx, projectId, pathParam(request, 'botId'), user, body)
    return { bot }
  })

  app.delete('/v1/projects/:id/bots/:botId', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const bot = await updateBot(ctx, projectId, pathParam(request, 'botId'), user, { status: 'archived' })
    return { bot }
  })
}
