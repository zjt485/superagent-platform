import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { parseBody, queryOf, requireUser, uuidParam } from '../../http/helpers.js'
import {
  createMcpServer,
  deleteMcpServer,
  discoverMcpServerTools,
  getArtifactFile,
  listMcpServers,
  listProjectArtifacts,
  updateMcpServer,
} from '../../services/connectors.js'

const createMcpSchema = z.object({
  name: z.string().trim().min(1).max(64),
  transport: z.enum(['stdio', 'streamable_http', 'sse']).optional(),
  endpointOrCmd: z.string().trim().min(1).max(1000),
  args: z.array(z.string().max(400)).max(30).optional(),
  envRefs: z.record(z.string().max(120), z.string().max(120)).optional(),
  enabled: z.boolean().optional(),
  defaultToolPolicy: z.enum(['allow', 'confirm', 'confirm_all', 'deny']).optional(),
})

const updateMcpSchema = createMcpSchema.partial()

export function registerConnectorRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/projects/:id/mcp-servers', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const items = await listMcpServers(ctx, projectId, user)
    return { items }
  })

  app.post('/v1/projects/:id/mcp-servers', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const body = parseBody(createMcpSchema, request)
    const server = await createMcpServer(ctx, projectId, user, {
      name: body.name,
      endpointOrCmd: body.endpointOrCmd,
      ...(body.transport !== undefined ? { transport: body.transport } : {}),
      ...(body.args !== undefined ? { args: body.args } : {}),
      ...(body.envRefs !== undefined ? { envRefs: body.envRefs } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.defaultToolPolicy !== undefined ? { defaultToolPolicy: body.defaultToolPolicy } : {}),
    })
    reply.code(201)
    return { server }
  })

  app.patch('/v1/projects/:id/mcp-servers/:serverId', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request, 'id')
    const serverId = uuidParam(request, 'serverId')
    const body = parseBody(updateMcpSchema, request)
    const server = await updateMcpServer(ctx, projectId, serverId, user, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.transport !== undefined ? { transport: body.transport } : {}),
      ...(body.endpointOrCmd !== undefined ? { endpointOrCmd: body.endpointOrCmd } : {}),
      ...(body.args !== undefined ? { args: body.args } : {}),
      ...(body.envRefs !== undefined ? { envRefs: body.envRefs } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.defaultToolPolicy !== undefined ? { defaultToolPolicy: body.defaultToolPolicy } : {}),
    })
    return { server }
  })

  app.delete('/v1/projects/:id/mcp-servers/:serverId', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request, 'id')
    const serverId = uuidParam(request, 'serverId')
    await deleteMcpServer(ctx, projectId, serverId, user)
    reply.code(204)
    return null
  })

  app.post('/v1/projects/:id/mcp-servers/:serverId/discover', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request, 'id')
    const serverId = uuidParam(request, 'serverId')
    return discoverMcpServerTools(ctx, projectId, serverId, user)
  })

  app.get('/v1/projects/:id/artifacts', async (request) => {
    const user = requireUser(request)
    const projectId = uuidParam(request)
    const limit = Number(queryOf(request).limit ?? 50)
    const items = await listProjectArtifacts(ctx, projectId, user, Number.isFinite(limit) ? limit : 50)
    return { items }
  })

  app.get('/v1/projects/:id/artifacts/:artifactId', async (request, reply) => {
    const user = requireUser(request)
    const projectId = uuidParam(request, 'id')
    const artifactId = uuidParam(request, 'artifactId')
    const { artifact, buffer } = await getArtifactFile(ctx, projectId, artifactId, user)
    reply.header('content-type', artifact.mimeType)
    reply.header('cache-control', 'private, max-age=3600')
    reply.header('content-disposition', 'inline')
    return reply.send(buffer)
  })
}
