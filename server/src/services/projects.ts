import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Deps } from './deps.js'
import {
  channels,
  identities,
  projectInstallations,
  projectMembers,
  projects,
  repos,
  runs,
  tickets,
  users,
  type ProjectRow,
} from '../db/schema.js'
import { conflict, forbidden, notFound } from '../errors.js'
import { newId, slugify } from '../domain/ids.js'
import { DEFAULT_MODEL_CONFIG, DEFAULT_POLICY, modelConfigSchema, parsePolicy, projectPolicySchema } from '../domain/policy.js'
import { ACTIVE_TICKET_STATUSES, PROJECT_STATUS_TRANSITIONS, type MemberRole, type ProjectStatus } from '../domain/status.js'
import { audit } from './audit.js'
import { assertOwner, requireProjectAccess, type ProjectAccess } from './access.js'
import { isUniqueViolation } from '../db/errors.js'

export interface CreateProjectInput {
  name: string
  slug?: string
  description?: string
  policy?: unknown
  modelConfig?: unknown
}

export interface ProjectSummary {
  id: string
  name: string
  slug: string
  description: string | null
  status: ProjectStatus
  role: MemberRole | null
  repo: { owner: string; name: string; fullName: string; defaultBranch: string; installationId: string } | null
  channel: { id: string; provider: string; name: string | null; externalChatId: string } | null
  openTickets: number
  runningRuns: number
  memberCount: number
  createdAt: Date
  updatedAt: Date
}

export async function createProject(deps: Deps, creator: { id: string; name: string }, input: CreateProjectInput): Promise<ProjectRow> {
  const name = input.name.trim()
  if (!name) throw conflict('项目名称不能为空')
  const base = slugify(input.slug ?? name)
  let slug = base
  for (let attempt = 2; attempt < 50; attempt += 1) {
    const [existing] = await deps.db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug))
    if (!existing) break
    slug = `${base}-${attempt}`
  }

  const projectId = newId()
  const now = deps.now()
  try {
    await deps.db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id: projectId,
        name,
        slug,
        description: input.description?.trim() || null,
        ownerId: creator.id,
        status: 'draft',
        policyJson: input.policy === undefined ? DEFAULT_POLICY : projectPolicySchema.parse(input.policy),
        modelConfig: input.modelConfig === undefined ? DEFAULT_MODEL_CONFIG : modelConfigSchema.parse(input.modelConfig),
        createdAt: now,
        updatedAt: now,
      })
      await tx.insert(projectMembers).values({
        id: newId(),
        projectId,
        userId: creator.id,
        role: 'owner',
        joinedAt: now,
      })
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('项目标识已被占用')
    throw error
  }

  await audit(deps, {
    projectId,
    actorId: creator.id,
    actorLabel: creator.name,
    action: 'project.created',
    target: `project:${projectId}`,
    metadata: { name, slug },
  })
  const [row] = await deps.db.select().from(projects).where(eq(projects.id, projectId))
  if (!row) throw notFound('项目创建失败')
  return row
}

export async function listProjects(deps: Deps, user: { id: string; isAdmin: boolean }): Promise<ProjectSummary[]> {
  const memberships = await deps.db
    .select({ projectId: projectMembers.projectId, role: projectMembers.role })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id))

  const roleByProject = new Map(memberships.map((row) => [row.projectId, row.role]))
  const projectRows = user.isAdmin
    ? await deps.db.select().from(projects).orderBy(desc(projects.updatedAt))
    : memberships.length === 0
      ? []
      : await deps.db
          .select()
          .from(projects)
          .where(inArray(projects.id, [...roleByProject.keys()]))
          .orderBy(desc(projects.updatedAt))

  if (projectRows.length === 0) return []
  const ids = projectRows.map((row) => row.id)
  const repoRows = await deps.db.select().from(repos).where(inArray(repos.projectId, ids))
  const channelRows = await deps.db
    .select()
    .from(channels)
    .where(and(inArray(channels.projectId, ids), eq(channels.status, 'active')))
  const ticketCounts = await deps.db
    .select({ projectId: tickets.projectId, value: count() })
    .from(tickets)
    .where(and(inArray(tickets.projectId, ids), inArray(tickets.status, [...ACTIVE_TICKET_STATUSES])))
    .groupBy(tickets.projectId)
  const runCounts = await deps.db
    .select({ projectId: runs.projectId, value: count() })
    .from(runs)
    .where(and(inArray(runs.projectId, ids), eq(runs.status, 'running')))
    .groupBy(runs.projectId)
  const memberCounts = await deps.db
    .select({ projectId: projectMembers.projectId, value: count() })
    .from(projectMembers)
    .where(inArray(projectMembers.projectId, ids))
    .groupBy(projectMembers.projectId)

  const repoByProject = new Map(repoRows.map((row) => [row.projectId, row]))
  const channelByProject = new Map(channelRows.map((row) => [row.projectId, row]))
  const ticketsByProject = new Map(ticketCounts.map((row) => [row.projectId, Number(row.value)]))
  const runsByProject = new Map(runCounts.map((row) => [row.projectId, Number(row.value)]))
  const membersByProject = new Map(memberCounts.map((row) => [row.projectId, Number(row.value)]))

  return projectRows.map((row) => {
    const repo = repoByProject.get(row.id)
    const channel = channelByProject.get(row.id)
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      status: row.status,
      role: roleByProject.get(row.id) ?? (user.isAdmin ? 'owner' : null),
      repo: repo
        ? {
            owner: repo.owner,
            name: repo.name,
            fullName: repo.fullName,
            defaultBranch: repo.defaultBranch,
            installationId: repo.installationId,
          }
        : null,
      channel: channel
        ? { id: channel.id, provider: channel.provider, name: channel.name, externalChatId: channel.externalChatId }
        : null,
      openTickets: ticketsByProject.get(row.id) ?? 0,
      runningRuns: runsByProject.get(row.id) ?? 0,
      memberCount: membersByProject.get(row.id) ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  })
}

export async function projectBundle(deps: Deps, projectId: string, user: { id: string; isAdmin: boolean }) {
  const access = await requireProjectAccess(deps, projectId, user.id, user.isAdmin)
  const [repo] = await deps.db.select().from(repos).where(eq(repos.projectId, projectId))
  const [channel] = await deps.db
    .select()
    .from(channels)
    .where(and(eq(channels.projectId, projectId), eq(channels.status, 'active')))
  const [{ value: memberCount } = { value: 0 }] = await deps.db
    .select({ value: count() })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId))
  return {
    ...access.project,
    role: access.role,
    repo: repo ?? null,
    channel: channel ?? null,
    memberCount: Number(memberCount),
    readiness: {
      repo: Boolean(repo),
      channel: Boolean(channel),
      canActivate: Boolean(repo && channel),
    },
  }
}

export interface UpdateProjectInput {
  name?: string
  description?: string | null
  policy?: unknown
  modelConfig?: unknown
  status?: ProjectStatus
}

export async function updateProject(
  deps: Deps,
  projectId: string,
  user: { id: string; name: string; isAdmin: boolean },
  input: UpdateProjectInput,
): Promise<ProjectRow> {
  const access = await requireProjectAccess(deps, projectId, user.id, user.isAdmin)
  const project = access.project
  // Only status changes are available to maintainers (pause/resume); every
  // other setting, activation and archiving stay with the Owner.
  const nonStatusKeys = Object.keys(input).filter((key) => key !== 'status')
  if (nonStatusKeys.length > 0) assertOwner(access)
  if (input.status !== undefined && input.status !== project.status) {
    const ownerOnly =
      input.status === 'archived' ||
      project.status === 'draft' ||
      (input.status === 'active' && project.status !== 'paused')
    if (ownerOnly) {
      assertOwner(access)
    } else if (access.role !== 'owner' && access.role !== 'maintainer') {
      throw forbidden('只有 Owner 或 Maintainer 可以暂停/恢复项目')
    }
  }
  const patch: Partial<typeof projects.$inferInsert> = { updatedAt: deps.now() }

  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw conflict('项目名称不能为空')
    patch.name = name
  }
  if (input.description !== undefined) patch.description = input.description?.trim() || null
  if (input.policy !== undefined) patch.policyJson = projectPolicySchema.parse(input.policy)
  if (input.modelConfig !== undefined) patch.modelConfig = modelConfigSchema.parse(input.modelConfig)

  if (input.status !== undefined && input.status !== project.status) {
    const target = input.status
    if (!PROJECT_STATUS_TRANSITIONS[project.status].includes(target)) {
      throw conflict(`项目状态不能从 ${project.status} 变为 ${target}`)
    }
    if (target === 'active') {
      const [repo] = await deps.db.select({ id: repos.id }).from(repos).where(eq(repos.projectId, projectId))
      const [channel] = await deps.db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.projectId, projectId), eq(channels.status, 'active')))
      if (!repo || !channel) {
        throw conflict('启用项目前必须绑定 GitHub 仓库和一个 IM 群')
      }
    }
    patch.status = target
    if (target === 'archived') patch.archivedAt = deps.now()
  }

  if (input.status === 'archived' && project.status !== 'archived') {
    // Archiving makes the project read-only: drop queued work and ask running
    // workers to stop, so nothing executes after the decision.
    await deps.db
      .update(runs)
      .set({ status: 'cancelled', endedAt: deps.now(), error: 'project archived' })
      .where(and(eq(runs.projectId, projectId), eq(runs.status, 'queued')))
    await deps.db
      .update(runs)
      .set({ cancelRequestedAt: deps.now() })
      .where(and(eq(runs.projectId, projectId), eq(runs.status, 'running')))
  }

  await deps.db.update(projects).set(patch).where(eq(projects.id, projectId))
  await audit(deps, {
    projectId,
    actorId: user.id,
    actorLabel: user.name,
    action: input.status && input.status !== project.status ? 'project.status_changed' : 'project.updated',
    target: `project:${projectId}`,
    metadata: {
      ...(input.status ? { from: project.status, to: input.status } : {}),
      ...(input.policy !== undefined ? { policy: true } : {}),
    },
  })
  const [row] = await deps.db.select().from(projects).where(eq(projects.id, projectId))
  if (!row) throw notFound('项目不存在')
  return row
}

export async function listMembers(deps: Deps, projectId: string) {
  return deps.db
    .select({
      id: projectMembers.id,
      userId: users.id,
      name: users.name,
      avatar: users.avatar,
      role: projectMembers.role,
      joinedAt: projectMembers.joinedAt,
      identities: sql<string>`(
        select string_agg(i.provider || ':' || i.external_id, ', ')
        from identities i where i.user_id = ${users.id}
      )`,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(projectMembers.joinedAt))
}

async function ownerCount(deps: Deps, projectId: string): Promise<number> {
  const [row] = await deps.db
    .select({ value: count() })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, 'owner')))
  return Number(row?.value ?? 0)
}

export async function addMemberByUserId(
  deps: Deps,
  projectId: string,
  actor: { id: string; name: string; isAdmin: boolean },
  input: { userId: string; role: MemberRole },
) {
  const access = await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin)
  assertOwner(access)
  if (input.role === 'owner') throw forbidden('不能通过成员接口直接授予 Owner，请先转移所有权')
  const [user] = await deps.db.select().from(users).where(eq(users.id, input.userId))
  if (!user) throw notFound('用户不存在')
  const [existing] = await deps.db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, input.userId)))
  if (existing) throw conflict('该用户已经是项目成员')
  await deps.db.insert(projectMembers).values({
    id: newId(),
    projectId,
    userId: input.userId,
    role: input.role,
    invitedBy: actor.id,
    joinedAt: deps.now(),
  })
  await audit(deps, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'member.added',
    target: `user:${input.userId}`,
    metadata: { role: input.role },
  })
}

export async function addMemberByIdentity(
  deps: Deps,
  projectId: string,
  actor: { id: string; name: string; isAdmin: boolean },
  input: { provider: string; externalId: string; role: MemberRole },
) {
  const [identity] = await deps.db
    .select({ userId: identities.userId })
    .from(identities)
    .where(and(eq(identities.provider, input.provider), eq(identities.externalId, input.externalId)))
  if (!identity) throw notFound('该 IM 账号尚未登录过平台，请让对方先通过邀请链接登录')
  await addMemberByUserId(deps, projectId, actor, { userId: identity.userId, role: input.role })
}

export async function changeMemberRole(
  deps: Deps,
  projectId: string,
  actor: { id: string; name: string; isAdmin: boolean },
  targetUserId: string,
  role: MemberRole,
) {
  const access = await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin)
  assertOwner(access)
  const [target] = await deps.db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)))
  if (!target) throw notFound('成员不存在')
  if (target.role === role) return
  if (target.role === 'owner' && role !== 'owner') {
    if ((await ownerCount(deps, projectId)) <= 1) throw conflict('项目至少需要一个 Owner')
  }
  if (role === 'owner' && target.role !== 'owner') {
    throw forbidden('不能通过成员接口直接授予 Owner，请使用所有权转移')
  }
  await deps.db
    .update(projectMembers)
    .set({ role })
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)))
  await audit(deps, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'member.role_changed',
    target: `user:${targetUserId}`,
    metadata: { from: target.role, to: role },
  })
}

export async function removeMember(
  deps: Deps,
  projectId: string,
  actor: { id: string; name: string; isAdmin: boolean },
  targetUserId: string,
) {
  const access = await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin)
  assertOwner(access)
  const [target] = await deps.db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)))
  if (!target) throw notFound('成员不存在')
  if (target.role === 'owner') {
    if ((await ownerCount(deps, projectId)) <= 1) throw conflict('项目至少需要一个 Owner')
    if (targetUserId === access.project.ownerId) throw conflict('现任 Owner 不能直接移除自己，请先转移所有权')
  }
  await deps.db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)))
  await audit(deps, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'member.removed',
    target: `user:${targetUserId}`,
  })
}

export async function recordInstallation(
  deps: Deps,
  projectId: string,
  installation: { installationId: string; accountLogin?: string; accountType?: string },
) {
  await deps.db
    .insert(projectInstallations)
    .values({
      id: newId(),
      projectId,
      installationId: installation.installationId,
      accountLogin: installation.accountLogin ?? null,
      accountType: installation.accountType ?? null,
      createdAt: deps.now(),
    })
    .onConflictDoUpdate({
      target: [projectInstallations.projectId, projectInstallations.installationId],
      set: { accountLogin: installation.accountLogin ?? null },
    })
  await audit(deps, {
    projectId,
    action: 'github.installation_recorded',
    target: `installation:${installation.installationId}`,
  })
}

export async function listInstallations(deps: Deps, projectId: string) {
  return deps.db.select().from(projectInstallations).where(eq(projectInstallations.projectId, projectId)).orderBy(desc(projectInstallations.createdAt))
}

export async function bindRepo(
  deps: Deps,
  projectId: string,
  actor: { id: string; name: string; isAdmin: boolean },
  input: { installationId: string; owner: string; name: string; defaultBranch?: string; private?: boolean },
) {
  const access = await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin)
  assertOwner(access)
  if (access.project.status === 'archived') throw conflict('已归档项目不能修改仓库')
  const owner = input.owner.trim()
  const name = input.name.trim()
  if (!owner || !name) throw conflict('仓库 owner 和 name 不能为空')
  const fullName = `${owner}/${name}`
  try {
    await deps.db
      .insert(repos)
      .values({
        id: newId(),
        projectId,
        provider: 'github',
        installationId: input.installationId,
        owner,
        name,
        fullName,
        defaultBranch: input.defaultBranch?.trim() || 'main',
        private: input.private ?? true,
        createdAt: deps.now(),
        updatedAt: deps.now(),
      })
      .onConflictDoUpdate({
        target: repos.projectId,
        set: {
          installationId: input.installationId,
          owner,
          name,
          fullName,
          defaultBranch: input.defaultBranch?.trim() || 'main',
          private: input.private ?? true,
          updatedAt: deps.now(),
        },
      })
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('该仓库已绑定到其他项目')
    throw error
  }
  await deps.db.update(projects).set({ updatedAt: deps.now() }).where(eq(projects.id, projectId))
  await audit(deps, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'repo.bound',
    target: `repo:${fullName}`,
    metadata: { installationId: input.installationId, defaultBranch: input.defaultBranch ?? 'main' },
  })
}

export async function unbindRepo(deps: Deps, projectId: string, actor: { id: string; name: string; isAdmin: boolean }) {
  const access = await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin)
  assertOwner(access)
  await deps.db.delete(repos).where(eq(repos.projectId, projectId))
  await audit(deps, { projectId, actorId: actor.id, actorLabel: actor.name, action: 'repo.unbound', target: `project:${projectId}` })
}

export async function bindChannel(
  deps: Deps,
  projectId: string,
  actor: { id: string; name: string; isAdmin: boolean },
  input: { provider: 'feishu' | 'wecom'; externalChatId: string; name?: string; config?: Record<string, unknown> },
) {
  const access = await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin)
  assertOwner(access)
  if (access.project.status === 'archived') throw conflict('已归档项目不能绑定群')
  const externalChatId = input.externalChatId.trim()
  if (!externalChatId) throw conflict('群 ID 不能为空')

  const [existing] = await deps.db
    .select()
    .from(channels)
    .where(and(eq(channels.provider, input.provider), eq(channels.externalChatId, externalChatId)))
  if (existing && existing.projectId !== projectId) throw conflict('该群已绑定到其他项目')

  await deps.db.transaction(async (tx) => {
    await tx
      .update(channels)
      .set({ status: 'disabled', updatedAt: deps.now() })
      .where(and(eq(channels.projectId, projectId), eq(channels.status, 'active')))
    if (existing) {
      await tx
        .update(channels)
        .set({
          status: 'active',
          name: input.name?.trim() || existing.name,
          config: input.config ?? existing.config,
          updatedAt: deps.now(),
        })
        .where(eq(channels.id, existing.id))
    } else {
      await tx.insert(channels).values({
        id: newId(),
        projectId,
        provider: input.provider,
        externalChatId,
        name: input.name?.trim() || null,
        status: 'active',
        config: input.config ?? {},
        createdBy: actor.id,
        createdAt: deps.now(),
        updatedAt: deps.now(),
      })
    }
  })
  await audit(deps, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'channel.bound',
    target: `channel:${input.provider}:${externalChatId}`,
    metadata: { provider: input.provider, name: input.name ?? null },
  })
}

export async function unbindChannel(
  deps: Deps,
  projectId: string,
  channelId: string,
  actor: { id: string; name: string; isAdmin: boolean },
) {
  const access = await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin)
  assertOwner(access)
  const [channel] = await deps.db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.projectId, projectId)))
  if (!channel) throw notFound('群绑定不存在')
  await deps.db.update(channels).set({ status: 'disabled', updatedAt: deps.now() }).where(eq(channels.id, channelId))
  await audit(deps, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'channel.unbound',
    target: `channel:${channel.provider}:${channel.externalChatId}`,
  })
}

/** Resolves an active channel binding for an inbound chat, scoped to provider. */
export async function channelByExternalChat(deps: Deps, provider: 'feishu' | 'wecom', externalChatId: string) {
  const [row] = await deps.db
    .select()
    .from(channels)
    .where(and(eq(channels.provider, provider), eq(channels.externalChatId, externalChatId), eq(channels.status, 'active')))
  return row ?? null
}

export async function projectBySlug(deps: Deps, slug: string) {
  const [row] = await deps.db.select().from(projects).where(eq(projects.slug, slug))
  return row ?? null
}
