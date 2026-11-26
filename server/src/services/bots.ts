import { and, asc, eq } from 'drizzle-orm'

import type { Deps } from './deps.js'
import { audit } from './audit.js'
import { requireProjectAccess } from './access.js'
import { newId, slugify } from '../domain/ids.js'
import { isUniqueViolation } from '../db/errors.js'
import { conflict, notFound } from '../errors.js'
import {
  bots,
  roomBots,
  rooms,
  type BotImBinding,
  type BotModelConfig,
  type BotRow,
  type BotSandboxConfig,
  type BotToolPolicy,
} from '../db/schema.js'

export interface BotTemplate {
  slug: string
  name: string
  roleTitle: string
  avatar: string
  systemPrompt: string
  toolPolicy: BotToolPolicy
  sandboxConfig: BotSandboxConfig
}

/** Default 4-role R&D digital employee squad for one-click onboarding. */
export const RD_BOT_TEMPLATES: readonly BotTemplate[] = [
  {
    slug: 'researcher',
    name: '调研员',
    roleTitle: '需求与竞品研究',
    avatar: '🔍',
    systemPrompt: [
      '你是产研团队的「需求与竞品研究」数字员工（@researcher）。',
      '职责：搜集资料、分析用户痛点与竞品方案、输出结构化对比结论。',
      '当调研完成且需要进入需求拆解时，使用 handoff 工具交接给 @pm；若结论明确可直接改代码，可交接给 @engineer。',
    ].join('\n'),
    toolPolicy: {
      allowedTools: ['read_file', 'list_files', 'write_file', 'browser_open', 'browser_extract', 'browser_screenshot', 'handoff'],
      rules: {
        github_push_and_pr: 'deny',
        run_command: 'confirm',
      },
    },
    sandboxConfig: { mode: 'local', browserEnabled: true, memoryMb: 1024, cpus: 1 },
  },
  {
    slug: 'pm',
    name: '产品经理',
    roleTitle: 'PRD 与验收拆解',
    avatar: '📋',
    systemPrompt: [
      '你是产研团队的「产品经理」数字员工（@pm）。',
      '职责：澄清需求边界、编写清晰简洁的 PRD 与验收标准（AC）、评估方案优先级。',
      '当规格确认可进入研发实现时，使用 handoff 工具交接给 @engineer，附带明确的验收标准。',
    ].join('\n'),
    toolPolicy: {
      allowedTools: ['read_file', 'list_files', 'write_file', 'browser_open', 'browser_screenshot', 'handoff'],
      rules: {
        github_push_and_pr: 'confirm',
        run_command: 'confirm',
      },
    },
    sandboxConfig: { mode: 'local', browserEnabled: true, memoryMb: 1024, cpus: 1 },
  },
  {
    slug: 'engineer',
    name: '全栈工程师',
    roleTitle: '编码与 PR 交付',
    avatar: '🛠️',
    systemPrompt: [
      '你是产研团队的「全栈工程师」数字员工（@engineer）。',
      '职责：阅读代码仓库、实现需求与修复缺陷、补充自动化测试并跑通验证。',
      '实现验证完毕后，可交由平台提交分支开 PR，必要时使用 handoff 工具交接给 @qa 做回归巡检。',
    ].join('\n'),
    toolPolicy: {
      allowedTools: ['read_file', 'write_file', 'list_files', 'run_command', 'browser_open', 'browser_screenshot', 'handoff'],
      rules: {
        github_push_and_pr: 'confirm',
      },
    },
    sandboxConfig: { mode: 'local', browserEnabled: true, memoryMb: 2048, cpus: 2 },
  },
  {
    slug: 'qa',
    name: 'QA 巡检',
    roleTitle: '验证与 7×24 巡检',
    avatar: '🧪',
    systemPrompt: [
      '你是产研团队的「QA 巡检」数字员工（@qa）。',
      '职责：执行接口与浏览器回归验证、复现线上/测试环境缺陷、截图取证并输出质量报告。',
      '如发现可复现缺陷，附带复现步骤与截图使用 handoff 工具交接给 @engineer 修复。',
    ].join('\n'),
    toolPolicy: {
      allowedTools: ['read_file', 'list_files', 'run_command', 'browser_open', 'browser_click', 'browser_type', 'browser_extract', 'browser_screenshot', 'handoff'],
      rules: {
        github_push_and_pr: 'confirm',
      },
    },
    sandboxConfig: { mode: 'local', browserEnabled: true, memoryMb: 2048, cpus: 2 },
  },
]

export interface CreateBotInput {
  slug?: string
  name: string
  roleTitle: string
  avatar?: string | null
  systemPrompt?: string
  modelConfig?: BotModelConfig
  toolPolicy?: BotToolPolicy
  sandboxConfig?: BotSandboxConfig
  imBinding?: BotImBinding | null
}

export interface UpdateBotInput {
  name?: string
  roleTitle?: string
  avatar?: string | null
  status?: 'active' | 'paused' | 'archived'
  systemPrompt?: string
  modelConfig?: BotModelConfig
  toolPolicy?: BotToolPolicy
  sandboxConfig?: BotSandboxConfig
  imBinding?: BotImBinding | null
}

export function formatBotSignature(bot: Pick<BotRow, 'name' | 'roleTitle'> | null | undefined, text: string): string {
  if (!bot) return text
  const prefix = `[${bot.name} · ${bot.roleTitle}]`
  return text.startsWith(prefix) ? text : `${prefix}\n${text}`
}

export async function listBots(deps: Deps, projectId: string): Promise<BotRow[]> {
  return deps.db
    .select()
    .from(bots)
    .where(eq(bots.projectId, projectId))
    .orderBy(asc(bots.createdAt))
}

export async function getBot(deps: Deps, projectId: string, botId: string): Promise<BotRow> {
  const [row] = await deps.db
    .select()
    .from(bots)
    .where(and(eq(bots.projectId, projectId), eq(bots.id, botId)))
  if (!row) throw notFound('Bot 不存在')
  return row
}

export async function getBotBySlug(deps: Deps, projectId: string, slug: string): Promise<BotRow | null> {
  const [row] = await deps.db
    .select()
    .from(bots)
    .where(and(eq(bots.projectId, projectId), eq(bots.slug, slug.toLowerCase())))
  return row ?? null
}

export async function createBot(
  deps: Deps,
  projectId: string,
  actor: { id: string; name: string; isAdmin: boolean },
  input: CreateBotInput,
): Promise<BotRow> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'maintainer')

  const name = input.name.trim()
  const roleTitle = input.roleTitle.trim()
  if (!name) throw conflict('Bot 名称不能为空')
  if (!roleTitle) throw conflict('岗位角色不能为空')

  const slug = slugify(input.slug?.trim() || name).slice(0, 40)
  const at = deps.now()
  const id = newId()
  try {
    const [row] = await deps.db
      .insert(bots)
      .values({
        id,
        projectId,
        slug,
        name,
        roleTitle,
        avatar: input.avatar ?? '🤖',
        status: 'active',
        systemPrompt: input.systemPrompt ?? '',
        modelConfig: input.modelConfig ?? {},
        toolPolicy: input.toolPolicy ?? {},
        sandboxConfig: input.sandboxConfig ?? {},
        imBinding: input.imBinding ?? null,
        sandboxState: 'stopped',
        createdAt: at,
        updatedAt: at,
      })
      .returning()
    if (!row) throw new Error('createBot returned no row')

    // Automatically add newly created bot to active group rooms of the project.
    const groupRooms = await deps.db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.projectId, projectId), eq(rooms.kind, 'group'), eq(rooms.status, 'active')))
    for (const room of groupRooms) {
      await deps.db
        .insert(roomBots)
        .values({ id: newId(), roomId: room.id, botId: row.id, joinedAt: at })
        .onConflictDoNothing()
    }

    await audit(deps, {
      projectId,
      actorId: actor.id,
      actorLabel: actor.name,
      action: 'bot.created',
      target: `bot:${row.id}`,
      metadata: { slug: row.slug, name: row.name, roleTitle: row.roleTitle },
    })
    return row
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(`Bot 标识 @${slug} 已存在`)
    throw error
  }
}

export async function updateBot(
  deps: Deps,
  projectId: string,
  botId: string,
  actor: { id: string; name: string; isAdmin: boolean },
  input: UpdateBotInput,
): Promise<BotRow> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'maintainer')
  const existing = await getBot(deps, projectId, botId)

  const patch: Partial<typeof bots.$inferInsert> = { updatedAt: deps.now() }
  if (input.name !== undefined) patch.name = input.name.trim() || existing.name
  if (input.roleTitle !== undefined) patch.roleTitle = input.roleTitle.trim() || existing.roleTitle
  if (input.avatar !== undefined) patch.avatar = input.avatar
  if (input.status !== undefined) patch.status = input.status
  if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt
  if (input.modelConfig !== undefined) patch.modelConfig = input.modelConfig
  if (input.toolPolicy !== undefined) patch.toolPolicy = input.toolPolicy
  if (input.sandboxConfig !== undefined) patch.sandboxConfig = input.sandboxConfig
  if (input.imBinding !== undefined) patch.imBinding = input.imBinding

  const [row] = await deps.db
    .update(bots)
    .set(patch)
    .where(and(eq(bots.projectId, projectId), eq(bots.id, botId)))
    .returning()
  if (!row) throw notFound('Bot 不存在')

  await audit(deps, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'bot.updated',
    target: `bot:${row.id}`,
    metadata: { status: row.status },
  })
  return row
}

/** One-click install of the 4-bot R&D squad template (idempotent by slug). */
export async function installRdBotTemplates(
  deps: Deps,
  projectId: string,
  actor: { id: string; name: string; isAdmin: boolean },
): Promise<{ created: BotRow[]; items: BotRow[] }> {
  await requireProjectAccess(deps, projectId, actor.id, actor.isAdmin, 'maintainer')

  const existing = await listBots(deps, projectId)
  const existingSlugs = new Set(existing.map((bot) => bot.slug))
  const created: BotRow[] = []

  for (const template of RD_BOT_TEMPLATES) {
    if (existingSlugs.has(template.slug)) continue
    const bot = await createBot(deps, projectId, actor, {
      slug: template.slug,
      name: template.name,
      roleTitle: template.roleTitle,
      avatar: template.avatar,
      systemPrompt: template.systemPrompt,
      toolPolicy: template.toolPolicy,
      sandboxConfig: template.sandboxConfig,
    })
    created.push(bot)
  }

  return { created, items: await listBots(deps, projectId) }
}
