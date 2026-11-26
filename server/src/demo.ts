import { configSchema } from './config.js'
import { loadLocalEnv } from './env.js'
import { openDatabase } from './db/client.js'
import { createLogger } from './logger.js'
import { depsOf } from './services/deps.js'
import { createDbQueue } from './queue/index.js'
import { MockGithubClient } from './github/client.js'
import { buildApp } from './app/build.js'
import type { AppContext } from './app/context.js'
import { loginWithIdentity } from './services/auth.js'
import { installRdBotTemplates } from './services/bots.js'
import { addMemberByUserId, bindChannel, bindRepo, createProject } from './services/projects.js'
import { createInvite } from './services/invites.js'
import { createRoutine } from './services/routines.js'
import { appendRoomMessage, ensureDefaultGroupRoom } from './services/rooms.js'
import { createManagedWecomGroup } from './services/wecom-join.js'
import { flushOutbox } from './services/outbox.js'
import { receiveCoreTrigger } from './core/intake.js'
import { McpClient } from './core/mcp/client.js'
import { createSandboxProvider } from './core/sandbox/docker.js'
import { coreTick } from './core/worker/tick.js'
import { dispatchOnce } from './core/worker/dispatcher.js'
import { startCoreLoop } from './core/worker/loop.js'
import { RuntimeExecutor } from './core/worker/runtime-executor.js'
import { GitDeliveryProvider } from './core/worker/delivery.js'
import { createDbWorkspaceProvider } from './core/worker/workspace-provider.js'
import { RuleBasedRouterModel } from './core/router/model.js'
import { FakeTurnRuntime } from './core/agent/runtime.js'
import { FakeGitOps } from './worker/fake-git.js'
import { and, desc, eq } from 'drizzle-orm'
import QRCode from 'qrcode'
import { channels, identities, projects, tickets } from './db/schema.js'
import type { ChannelProvider } from './domain/status.js'
import type { ImAdapter } from './domain/im.js'
import { newId } from './domain/ids.js'

loadLocalEnv()
const port = Number(process.env.DEMO_PORT ?? 3100)
const config = configSchema.parse({
  NODE_ENV: 'development',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  HOST: '127.0.0.1',
  PORT: port,
  PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
  APP_NAME: 'Superagent Demo',
  PGLITE_DIR: './data/demo',
  WORKSPACES_DIR: './data/demo-workspaces',
  AUTH_DEV_LOGIN: true,
  MIGRATE_ON_START: true,
  GITHUB_MODE: 'mock',
  AGENT_RUNTIME: 'fake',
  QUEUE_DRIVER: 'db',
  GITHUB_WEBHOOK_SECRET: 'demo-github-webhook-secret',
  FEISHU_VERIFICATION_TOKEN: 'demo-verification-token',
  FEISHU_ENCRYPT_KEY: 'demo-encrypt-key-0123456789abcdef',
  FEISHU_BOT_OPEN_ID: 'ou_demo_bot',
  SERVE_WEB: true,
})

const log = createLogger(config, { role: 'demo' })
const handle = await openDatabase(config)
const deps = depsOf({ config, db: handle.db, log })
const github = new MockGithubClient(config)
const ctx: AppContext = {
  ...deps,
  queue: createDbQueue(),
  im: {},
  oauth: {},
  github,
  senders: new Map<ChannelProvider, { provider: ChannelProvider; send(input: { chatId: string; text: string }): Promise<{ messageId?: string }> }>(),
  startedAt: new Date(),
}

const consoleSender = {
  provider: 'feishu' as const,
  async send(input: { chatId: string; text: string }) {
    process.stdout.write(`\n[模拟飞书 ${input.chatId}] ${input.text.replace(/\n/g, '\n    ')}\n`)
    return { messageId: `demo_${Date.now()}` }
  },
}
ctx.senders.set('feishu', consoleSender)
ctx.senders.set('wecom', {
  provider: 'wecom',
  async send(input) {
    process.stdout.write(`\n[模拟企业微信 ${input.chatId}] ${input.text.replace(/\n/g, '\n    ')}\n`)
    return { messageId: `demo_wc_${Date.now()}` }
  },
})

const demoWecomGroups = new Map<string, string[]>()
const demoWecomAdapter: ImAdapter = {
  provider: 'wecom',
  async verifyAndParse() {
    return { events: [], deliveryIds: [] }
  },
  async send(input) {
    process.stdout.write(`\n[模拟企业微信 ${input.chatId}] ${input.text.replace(/\n/g, '\n    ')}\n`)
    return { messageId: `demo_wc_${Date.now()}` }
  },
  async createChat(input) {
    const chatId = `wc_demo_${Math.random().toString(36).slice(2, 10)}`
    demoWecomGroups.set(chatId, [...new Set([input.ownerUserId, ...input.userIds])])
    return { chatId }
  },
  async addMembers(input) {
    const current = new Set(demoWecomGroups.get(input.chatId) ?? [])
    const added = input.externalUserIds.filter((id) => !current.has(id))
    for (const id of added) current.add(id)
    demoWecomGroups.set(input.chatId, [...current])
    return { added }
  },
}
ctx.im = { wecom: demoWecomAdapter }

async function linkIdentity(userId: string, provider: string, externalId: string, name: string): Promise<void> {
  const [existing] = await handle.db
    .select({ id: identities.id })
    .from(identities)
    .where(and(eq(identities.provider, provider), eq(identities.externalId, externalId)))
  if (existing) return
  await handle.db.insert(identities).values({
    id: newId(),
    userId,
    provider,
    externalId,
    displayName: name,
    createdAt: new Date(),
  })
}

const workspace = createDbWorkspaceProvider({
  db: handle.db,
  rootDir: config.WORKSPACES_DIR,
  github,
  webBase: config.GITHUB_WEB_BASE,
})
const delivery = new GitDeliveryProvider({
  db: handle.db,
  git: new FakeGitOps(),
  github,
  author: { name: config.GIT_AUTHOR_NAME, email: config.GIT_AUTHOR_EMAIL },
  webBase: config.GITHUB_WEB_BASE,
})
const routerModel = new RuleBasedRouterModel()
const executor = new RuntimeExecutor(new FakeTurnRuntime({ delayMs: 20 }))

const existingProjects = await handle.db.select().from(projects)
if (existingProjects.length === 0) {
  process.stdout.write('首次运行：正在创建演示项目，并跑通 Router → Executor → PR…\n')
  const alice = await loginWithIdentity(ctx, 'feishu', { externalId: 'ou_alice', name: 'Alice' })
  const bob = await loginWithIdentity(ctx, 'feishu', { externalId: 'ou_bob', name: 'Bob' })
  await linkIdentity(alice.id, 'dev', 'dev-alice', 'Alice')
  await linkIdentity(bob.id, 'dev', 'dev-bob', 'Bob')
  await linkIdentity(alice.id, 'wecom', 'wx_alice', 'Alice')
  await linkIdentity(bob.id, 'wecom', 'wx_bob', 'Bob')

  const project = await createProject(ctx, alice, {
    name: '演示项目',
    description: '由 pnpm demo 创建：4 人产研数字员工团队（@researcher/@pm/@engineer/@qa）、协作房间、工具级审批与 7×24 巡检。',
  })
  await bindRepo(ctx, project.id, alice, { installationId: '1', owner: 'demo-org', name: 'hello-world', defaultBranch: 'main' })
  await bindChannel(ctx, project.id, alice, { provider: 'feishu', externalChatId: 'oc_demo_project', name: '演示项目群' })
  const [channel] = await handle.db.select().from(channels).where(and(eq(channels.projectId, project.id), eq(channels.status, 'active')))
  await addMemberByUserId(ctx, project.id, alice, { userId: bob.id, role: 'member' })

  // Seed the 4-role R&D Bot squad, bind default Room to channel, and configure a QA daily Routine.
  const installedBots = await installRdBotTemplates(ctx, project.id, alice)
  const room = await ensureDefaultGroupRoom(handle.db, project.id, new Date(), channel?.id ?? null)
  const engineerBot = installedBots.items.find((b) => b.slug === 'engineer') ?? null
  const qaBot = installedBots.items.find((b) => b.slug === 'qa') ?? null
  await appendRoomMessage(handle.db, {
    projectId: project.id,
    roomId: room.id,
    threadKey: `room:${room.id}`,
    authorKind: 'system',
    kind: 'status',
    content: '产研数字员工团队已入驻本房间：@researcher（调研）、@pm（产品）、@engineer（全栈开发）、@qa（测试巡检）。直接描述需求或 @点名即可开始协作。',
    syncToIm: false,
    at: new Date(),
  })
  await createRoutine(ctx, project.id, alice, {
    name: '每日 09:00 QA 回归与依赖巡检',
    description: '自动检查最新主分支测试与依赖健康度，无异常时静默归档，发现异常时通知群成员。',
    botId: qaBot?.id ?? null,
    roomId: room.id,
    triggerType: 'cron',
    cronExpr: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
    prompt: '请运行项目核心测试并检查构建状态；如全部通过请在总结中注明「一切正常」，如发现失败用例请定位原因并 @engineer。',
    notifyOnQuiet: false,
  })

  const wecomProject = await createProject(ctx, alice, {
    name: '企微扫码演示',
    description: '扫描项目详情页的二维码，使用企业微信登录后自动加入项目群。',
  })
  await bindRepo(ctx, wecomProject.id, alice, { installationId: '1', owner: 'demo-org', name: 'hello-world', defaultBranch: 'main' })
  await addMemberByUserId(ctx, wecomProject.id, alice, { userId: bob.id, role: 'member' })
  const wecomSetup = await createManagedWecomGroup(ctx, wecomProject.id, alice)

  const invite = await createInvite(ctx, project.id, alice, { role: 'member', maxUses: 20, expiresInHours: 72 })
  await receiveCoreTrigger(handle.db, {
    projectId: project.id,
    channelId: channel?.id ?? null,
    roomId: room.id,
    targetBotId: engineerBot?.id ?? null,
    provider: 'feishu',
    externalId: 'demo_trigger_1',
    threadKey: 'demo_thread_1',
    actorUserId: alice.id,
    actorExternalId: 'ou_alice',
    actorName: 'Alice',
    mentionedBot: true,
    address: 'mention',
    text: '@engineer 在 docs 下新增欢迎页，写明如何启动服务、如何跑测试，并把验证方式写清楚。',
    at: new Date(),
  })

  await coreTick({ db: handle.db, model: routerModel, now: () => new Date(), maxThreads: 10 })
  for (let index = 0; index < 4; index += 1) {
    const ran = await dispatchOnce({ db: handle.db, executor, workspace, delivery, now: () => new Date() })
    if (!ran) break
  }
  await flushOutbox(ctx, ctx.senders, 50)
  const [finalTicket] = await handle.db.select().from(tickets).orderBy(desc(tickets.createdAt)).limit(1)
  process.stdout.write(
    [
      '',
      '演示数据已就绪：',
      `  邀请：${invite.invite.url}（接受后可看到项目群二维码）`,
      `  项目：${project.name} (${project.slug})`,
      `  工单：${finalTicket?.title ?? '（无）'} → ${finalTicket?.stage ?? finalTicket?.status ?? '（无）'}`,
      `  PR：${finalTicket?.prUrl ?? '（未生成）'}`,
      `  企业微信演示项目：${wecomProject.name} → ${wecomSetup.join.url}`,
      '  企业微信群为演示适配器模拟；配置 WECOM_CORP_ID/SECRET 后使用真实 appchat。',
      '',
      '打开控制台后用开发登录：昵称 Alice（Owner）或 Bob（Member）；「企微扫码演示」项目详情页可看到扫码入群二维码。',
      '',
    ].join('\n'),
  )
}

const [demoProject] = await handle.db.select().from(projects).limit(1)
if (demoProject) {
  const [channel] = await handle.db
    .select()
    .from(channels)
    .where(and(eq(channels.projectId, demoProject.id), eq(channels.status, 'active')))
  if (channel) {
    const channelConfig = (channel.config ?? {}) as Record<string, unknown>
    if (typeof channelConfig.joinUrl !== 'string' || typeof channelConfig.qrDataUrl !== 'string') {
      const joinUrl = `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(channel.externalChatId)}`
      const qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, width: 320 })
      await handle.db
        .update(channels)
        .set({ config: { ...channelConfig, joinUrl, qrDataUrl, autoJoin: true }, updatedAt: new Date() })
        .where(eq(channels.id, channel.id))
    }
  }
}

const app = await buildApp(ctx)
const demoLoop = startCoreLoop({
  db: handle.db,
  model: routerModel,
  executor,
  workspace,
  delivery,
  sandbox: createSandboxProvider({ rootDir: config.WORKSPACES_DIR, defaultDockerImage: config.SANDBOX_IMAGE }),
  mcpClient: new McpClient(),
  artifactsRoot: config.WORKSPACES_DIR,
  events: deps.events,
  now: () => new Date(),
  intervalMs: 500,
  log,
})
const timers = [
  setInterval(() => {
    void flushOutbox(ctx, ctx.senders, 20).catch((error) => log.warn({ err: error }, 'outbox flush failed'))
  }, config.OUTBOX_INTERVAL_MS),
]
await app.listen({ host: config.HOST, port: config.PORT })
process.stdout.write(`\nSuperagent demo: ${config.PUBLIC_BASE_URL}\n登录页：${config.PUBLIC_BASE_URL}/login\n\n`)

async function shutdown(): Promise<void> {
  for (const timer of timers) clearInterval(timer)
  await demoLoop.stop().catch(() => {})
  await app.close().catch(() => {})
  await handle.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
