import { configSchema } from './config.js'
import { openDatabase } from './db/client.js'
import { createLogger } from './logger.js'
import { depsOf } from './services/deps.js'
import { createDbQueue } from './queue/index.js'
import { MockGithubClient } from './github/client.js'
import { buildApp } from './app/build.js'
import type { AppContext } from './app/context.js'
import { loginWithIdentity } from './services/auth.js'
import { addMemberByUserId, bindChannel, bindRepo, createProject, updateProject } from './services/projects.js'
import { createInvite } from './services/invites.js'
import { createTicket, getTicketById } from './services/tickets.js'
import { enqueuePlan } from './services/orchestrator.js'
import { claimNextRun } from './services/runs.js'
import { flushOutbox } from './services/outbox.js'
import { executeClaimedRun, type WorkerContext } from './worker/pipeline.js'
import { FakeGitOps } from './worker/fake-git.js'
import { FakeRuntime } from './runtime/fake.js'
import { and, eq } from 'drizzle-orm'
import QRCode from 'qrcode'
import { channels, projects } from './db/schema.js'
import type { ChannelProvider } from './domain/status.js'

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

const existing = await handle.db.select().from(projects)
if (existing.length === 0) {
  process.stdout.write('首次运行：正在创建演示项目并跑通「工单 → 计划 → PR」…\n')
  const alice = await loginWithIdentity(ctx, 'dev', { externalId: 'dev-alice', name: 'Alice' })
  const bob = await loginWithIdentity(ctx, 'dev', { externalId: 'dev-bob', name: 'Bob' })
  const project = await createProject(ctx, alice, {
    name: '演示项目',
    description: '由 pnpm demo 创建的示例项目：飞书群接单、Agent 开 PR、人工合并。',
  })
  await bindRepo(ctx, project.id, alice, { installationId: '1', owner: 'demo-org', name: 'hello-world', defaultBranch: 'main' })
  await bindChannel(ctx, project.id, alice, { provider: 'feishu', externalChatId: 'oc_demo_project', name: '演示项目群' })
  await updateProject(ctx, project.id, alice, { status: 'active' })
  await addMemberByUserId(ctx, project.id, alice, { userId: bob.id, role: 'member' })

  const invite = await createInvite(ctx, project.id, alice, { role: 'member', maxUses: 20, expiresInHours: 72 })
  const ticket = await createTicket(ctx, {
    projectId: project.id,
    requesterId: alice.id,
    requesterName: alice.name,
    title: '新增欢迎页并补充验证说明',
    body: '在 docs 下新增一个欢迎页，写明如何启动服务、如何跑测试，并把验证方式写清楚。',
  })
  await enqueuePlan(ctx, ticket)

  const workerCtx: WorkerContext = {
    config: ctx.config,
    db: ctx.db,
    log: ctx.log,
    now: ctx.now,
    queue: createDbQueue(),
    ports: { github, git: new FakeGitOps(), runtime: new FakeRuntime({ delayMs: 30 }) },
  }
  for (let index = 0; index < 2; index += 1) {
    const run = await claimNextRun(workerCtx, 'demo-worker')
    if (run) await executeClaimedRun(workerCtx, run)
  }
  await flushOutbox(ctx, ctx.senders, 50)
  const finalTicket = await getTicketById(ctx, ticket.id)
  process.stdout.write(
    [
      '',
      '演示数据已就绪：',
      `  邀请：${invite.invite.url}（接受后可看到项目群二维码）`,
      `  项目：${project.name} (${project.slug})`,
      `  工单：${finalTicket.title} → 状态 ${finalTicket.status}`,
      `  PR：${finalTicket.prUrl ?? '（未生成）'}`,
      '',
      '打开控制台后用开发登录：昵称 Alice（Owner）或 Bob（Member）。',
      '',
    ].join('\n'),
  )
}

// Ensure the demo group has a join link and QR so the invitation flow can
// demonstrate "accept project invite → scan to join the group" even on an
// already-seeded database.
const [demoProject] = await handle.db.select().from(projects).limit(1)
if (demoProject) {
  const [channel] = await handle.db
    .select()
    .from(channels)
    .where(and(eq(channels.projectId, demoProject.id), eq(channels.status, 'active')))
  if (channel) {
    const config = (channel.config ?? {}) as Record<string, unknown>
    if (typeof config.joinUrl !== 'string' || typeof config.qrDataUrl !== 'string') {
      const joinUrl = `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(channel.externalChatId)}`
      const qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, width: 320 })
      await handle.db
        .update(channels)
        .set({ config: { ...config, joinUrl, qrDataUrl, autoJoin: true }, updatedAt: new Date() })
        .where(eq(channels.id, channel.id))
    }
  }
}

const app = await buildApp(ctx)
const timers = [
  setInterval(() => {
    void flushOutbox(ctx, ctx.senders, 20).catch((error) => log.warn({ err: error }, 'outbox flush failed'))
  }, config.OUTBOX_INTERVAL_MS),
]
await app.listen({ host: config.HOST, port: config.PORT })
process.stdout.write(`\nSuperagent demo: ${config.PUBLIC_BASE_URL}\n登录页：${config.PUBLIC_BASE_URL}/login\n\n`)

async function shutdown(): Promise<void> {
  for (const timer of timers) clearInterval(timer)
  await app.close().catch(() => {})
  await handle.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
