import { and, eq } from 'drizzle-orm'
import type { Deps } from './deps.js'
import { forbidden, notFound } from '../errors.js'
import { projectMembers, projects, type ProjectRow } from '../db/schema.js'
import type { MemberRole } from '../domain/status.js'
import { atLeast } from '../domain/status.js'

export interface ProjectAccess {
  project: ProjectRow
  role: MemberRole
  isAdmin: boolean
}

export async function getProjectRow(deps: Deps, projectId: string): Promise<ProjectRow> {
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId))
  if (!project) throw notFound('项目不存在')
  return project
}

export async function getMembership(deps: Deps, projectId: string, userId: string): Promise<MemberRole | null> {
  const [member] = await deps.db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
  return member?.role ?? null
}

/** Resolves a project the user may access, or throws 404 to avoid leaking existence. */
export async function requireProjectAccess(
  deps: Deps,
  projectId: string,
  userId: string,
  userIsAdmin = false,
  minimum: MemberRole = 'viewer',
): Promise<ProjectAccess> {
  const [row] = await deps.db.select().from(projects).where(eq(projects.id, projectId))
  if (!row) throw notFound('项目不存在')
  const membership = await getMembership(deps, projectId, userId)
  if (!membership && !userIsAdmin) throw notFound('项目不存在')
  const role: MemberRole = membership ?? 'owner'
  if (!atLeast(role, minimum)) throw forbidden('当前角色没有权限执行该操作')
  return { project: row, role, isAdmin: userIsAdmin && !membership }
}

export function assertOwner(access: ProjectAccess): void {
  if (access.role !== 'owner') throw forbidden('只有项目 Owner 可以执行该操作')
}
