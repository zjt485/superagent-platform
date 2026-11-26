import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { artifacts, mcpServers, type ArtifactRow, type McpServerRow, type McpToolDescriptor } from '../db/schema.js'
import { newId } from '../domain/ids.js'
import { badRequest, conflict, notFound } from '../errors.js'
import { McpClient } from '../core/mcp/client.js'
import { requireProjectAccess } from './access.js'
import { audit } from './audit.js'
import type { Deps } from './deps.js'

export interface Actor {
  id: string
  isAdmin: boolean
}

export interface CreateMcpServerInput {
  name: string
  transport?: 'stdio' | 'streamable_http' | 'sse'
  endpointOrCmd: string
  args?: string[]
  envRefs?: Record<string, string>
  enabled?: boolean
  defaultToolPolicy?: 'allow' | 'confirm' | 'confirm_all' | 'deny'
}

export interface UpdateMcpServerInput {
  name?: string
  transport?: 'stdio' | 'streamable_http' | 'sse'
  endpointOrCmd?: string
  args?: string[]
  envRefs?: Record<string, string>
  enabled?: boolean
  defaultToolPolicy?: 'allow' | 'confirm' | 'confirm_all' | 'deny'
}

function normalizeServerName(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!cleaned) throw badRequest('MCP 服务器名称只能包含字母、数字、连字符或下划线')
  return cleaned.slice(0, 48)
}

function validateEndpoint(transport: 'stdio' | 'streamable_http' | 'sse', endpointOrCmd: string): void {
  const trimmed = endpointOrCmd.trim()
  if (!trimmed) throw badRequest('请填写 MCP 端点 URL 或命令')
  if (transport === 'streamable_http' || transport === 'sse') {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      throw badRequest('HTTP/SSE MCP 端点必须是有效的 URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw badRequest('MCP 端点仅支持 http:// 或 https://')
    }
  }
}

export async function listMcpServers(deps: Deps, projectId: string, actor: Actor): Promise<McpServerRow[]> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'viewer')
  return deps.db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.projectId, projectId))
    .orderBy(desc(mcpServers.createdAt))
}

export async function createMcpServer(
  deps: Deps,
  projectId: string,
  actor: Actor,
  input: CreateMcpServerInput,
): Promise<McpServerRow> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'maintainer')
  const name = normalizeServerName(input.name)
  const transport = input.transport ?? 'streamable_http'
  validateEndpoint(transport, input.endpointOrCmd)

  const [existing] = await deps.db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(and(eq(mcpServers.projectId, projectId), eq(mcpServers.name, name)))
  if (existing) throw conflict(`MCP 服务器 "${name}" 已存在`)

  const at = deps.now()
  const [created] = await deps.db
    .insert(mcpServers)
    .values({
      id: newId(),
      projectId,
      name,
      transport,
      endpointOrCmd: input.endpointOrCmd.trim(),
      args: input.args ?? [],
      envRefs: input.envRefs ?? {},
      enabled: input.enabled ?? true,
      defaultToolPolicy: input.defaultToolPolicy ?? 'confirm',
      cachedTools: [],
      lastHealthAt: null,
      createdAt: at,
      updatedAt: at,
    })
    .returning()

  await audit(deps, {
    projectId,
    actorId: actor.id,
    action: 'mcp.create',
    target: `mcp:${created!.id}`,
    metadata: { name, transport },
  })
  return created!
}

export async function updateMcpServer(
  deps: Deps,
  projectId: string,
  serverId: string,
  actor: Actor,
  patch: UpdateMcpServerInput,
): Promise<McpServerRow> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'maintainer')
  const [existing] = await deps.db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, serverId), eq(mcpServers.projectId, projectId)))
  if (!existing) throw notFound('MCP 服务器不存在')

  const nextTransport = patch.transport ?? existing.transport
  const nextEndpoint = patch.endpointOrCmd !== undefined ? patch.endpointOrCmd.trim() : existing.endpointOrCmd
  validateEndpoint(nextTransport, nextEndpoint)
  const nextName = patch.name !== undefined ? normalizeServerName(patch.name) : existing.name

  const [updated] = await deps.db
    .update(mcpServers)
    .set({
      name: nextName,
      transport: nextTransport,
      endpointOrCmd: nextEndpoint,
      ...(patch.args !== undefined ? { args: patch.args } : {}),
      ...(patch.envRefs !== undefined ? { envRefs: patch.envRefs } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.defaultToolPolicy !== undefined ? { defaultToolPolicy: patch.defaultToolPolicy } : {}),
      updatedAt: deps.now(),
    })
    .where(eq(mcpServers.id, serverId))
    .returning()

  await audit(deps, {
    projectId,
    actorId: actor.id,
    action: 'mcp.update',
    target: `mcp:${serverId}`,
    metadata: { name: nextName, enabled: updated!.enabled },
  })
  return updated!
}

export async function deleteMcpServer(
  deps: Deps,
  projectId: string,
  serverId: string,
  actor: Actor,
): Promise<void> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'maintainer')
  const [existing] = await deps.db
    .select({ id: mcpServers.id, name: mcpServers.name })
    .from(mcpServers)
    .where(and(eq(mcpServers.id, serverId), eq(mcpServers.projectId, projectId)))
  if (!existing) throw notFound('MCP 服务器不存在')
  await deps.db.delete(mcpServers).where(eq(mcpServers.id, serverId))
  await audit(deps, {
    projectId,
    actorId: actor.id,
    action: 'mcp.delete',
    target: `mcp:${serverId}`,
    metadata: { name: existing.name },
  })
}

export async function discoverMcpServerTools(
  deps: Deps,
  projectId: string,
  serverId: string,
  actor: Actor,
  client: McpClient = new McpClient(),
): Promise<{ server: McpServerRow; tools: McpToolDescriptor[] }> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'maintainer')
  const [server] = await deps.db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, serverId), eq(mcpServers.projectId, projectId)))
  if (!server) throw notFound('MCP 服务器不存在')

  const tools = await client.discoverTools({
    id: server.id,
    name: server.name,
    transport: server.transport,
    endpointOrCmd: server.endpointOrCmd,
    args: server.args,
    envRefs: server.envRefs,
    defaultToolPolicy: server.defaultToolPolicy,
  })
  const at = deps.now()
  const [updated] = await deps.db
    .update(mcpServers)
    .set({ cachedTools: tools, lastHealthAt: at, updatedAt: at })
    .where(eq(mcpServers.id, serverId))
    .returning()

  await audit(deps, {
    projectId,
    actorId: actor.id,
    action: 'mcp.discover',
    target: `mcp:${serverId}`,
    metadata: { name: server.name, toolCount: tools.length },
  })
  return { server: updated!, tools }
}

export async function listProjectArtifacts(
  deps: Deps,
  projectId: string,
  actor: Actor,
  limit = 50,
): Promise<ArtifactRow[]> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'viewer')
  return deps.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.projectId, projectId))
    .orderBy(desc(artifacts.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200))
}

export async function saveArtifact(input: {
  deps: Deps
  projectId: string
  ticketId?: string | null
  turnId?: string | null
  botId?: string | null
  kind: string
  title: string
  mimeType: string
  extension: string
  data: Buffer
}): Promise<ArtifactRow> {
  const id = newId()
  const at = input.deps.now()
  const ext = input.extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin'
  const dir = path.resolve(input.deps.config.WORKSPACES_DIR, 'artifacts', input.projectId)
  await mkdir(dir, { recursive: true })
  const storagePath = path.join(dir, `${id}.${ext}`)
  await writeFile(storagePath, input.data)
  const [row] = await input.deps.db
    .insert(artifacts)
    .values({
      id,
      projectId: input.projectId,
      ticketId: input.ticketId ?? null,
      turnId: input.turnId ?? null,
      botId: input.botId ?? null,
      kind: input.kind,
      title: input.title.slice(0, 200),
      mimeType: input.mimeType,
      storagePath,
      sizeBytes: input.data.byteLength,
      createdAt: at,
    })
    .returning()
  return row!
}

export async function getArtifactFile(
  deps: Deps,
  projectId: string,
  artifactId: string,
  actor: Actor,
): Promise<{ artifact: ArtifactRow; buffer: Buffer }> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'viewer')
  const [artifact] = await deps.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.projectId, projectId)))
  if (!artifact) throw notFound('产物文件不存在')
  const buffer = await readFile(artifact.storagePath).catch(() => null)
  if (!buffer) throw notFound('产物文件已丢失')
  return { artifact, buffer }
}
