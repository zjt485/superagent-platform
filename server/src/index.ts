import { githubMode, loadConfig } from './config.js'
import { loadLocalEnv } from './env.js'
import { createLogger } from './logger.js'
import { openDatabase } from './db/client.js'
import { createDbQueue, createRedisQueue } from './queue/index.js'
import { createGithub } from './github/index.js'
import { createIm } from './im/index.js'
import { startWecomBot } from './im/wecom-bot.js'
import { buildApp } from './app/build.js'
import type { AppContext } from './app/context.js'
import { depsOf } from './services/deps.js'
import { flushOutbox } from './services/outbox.js'
import { cleanupExpiredSessions } from './services/auth.js'
import { createTurnRuntime } from './core/agent/runtime.js'
import { RealGitOps } from './worker/git.js'
import { FakeGitOps } from './worker/fake-git.js'
import { startCoreLoop } from './core/worker/loop.js'
import { RuntimeExecutor } from './core/worker/runtime-executor.js'
import { routerModelFromConfig } from './core/router/from-config.js'
import { GitDeliveryProvider } from './core/worker/delivery.js'
import { createDbWorkspaceProvider } from './core/worker/workspace-provider.js'
import { reapStaleCoreTurns } from './core/worker/reaper.js'
import { createSandboxProvider } from './core/sandbox/docker.js'
import { McpClient } from './core/mcp/client.js'

loadLocalEnv()
const config = loadConfig()
const log = createLogger(config, { role: 'api' })
const handle = await openDatabase(config)
const deps = depsOf({ config, db: handle.db, log })
const redis = config.QUEUE_DRIVER === 'redis' ? createRedisQueue(config, log) : null
const queue = redis?.queue ?? createDbQueue()
const im = createIm(config, log)
const github = createGithub(config, log)

const ctx: AppContext = {
  ...deps,
  queue,
  im: im.adapters,
  oauth: im.oauth,
  github,
  senders: im.senders,
  startedAt: new Date(),
}

// WeCom smart robots receive group @ mentions over a long connection. The app
// chat adapter remains responsible for OAuth, group creation and addMembers.
const wecomBot = startWecomBot(ctx)
if (wecomBot) {
  const botSender = wecomBot.sender
  ctx.senders.set('wecom', {
    provider: 'wecom',
    async send(input) {
      try {
        return await botSender.send(input)
      } catch (error) {
        // The bot may not be in this chat; appchat can still send to it.
        ctx.log.warn({ err: error, chatId: input.chatId }, 'wecom bot send failed; falling back to appchat')
        const adapter = ctx.im.wecom
        if (!adapter) throw error
        return adapter.send(input)
      }
    },
  })
}

const app = await buildApp(ctx)

const coreLoop = config.INLINE_WORKER
  ? startCoreLoop({
      db: handle.db,
      model: routerModelFromConfig(config),
      executor: new RuntimeExecutor(createTurnRuntime(config, log)),
      workspace: createDbWorkspaceProvider({
        db: handle.db,
        rootDir: config.WORKSPACES_DIR,
        github,
        webBase: config.GITHUB_WEB_BASE,
      }),
      delivery: new GitDeliveryProvider({
        db: handle.db,
        git: githubMode(config) === 'mock' ? new FakeGitOps() : new RealGitOps(),
        github,
        author: { name: config.GIT_AUTHOR_NAME, email: config.GIT_AUTHOR_EMAIL },
        webBase: config.GITHUB_WEB_BASE,
      }),
      sandbox: createSandboxProvider({
        rootDir: config.WORKSPACES_DIR,
        defaultDockerImage: config.SANDBOX_IMAGE,
      }),
      mcpClient: new McpClient(),
      artifactsRoot: config.WORKSPACES_DIR,
      now: deps.now,
      intervalMs: config.CORE_POLL_INTERVAL_MS,
      leaseSeconds: config.RUN_LEASE_SECONDS,
      events: deps.events,
      log,
    })
  : null

const timers: NodeJS.Timeout[] = []
timers.push(
  setInterval(() => {
    void flushOutbox(ctx, ctx.senders, config.OUTBOX_BATCH_SIZE).catch((error) => log.warn({ err: error }, 'outbox flush failed'))
  }, config.OUTBOX_INTERVAL_MS),
)
timers.push(
  setInterval(() => {
    void reapStaleCoreTurns({ db: handle.db, now: deps.now, leaseSeconds: config.RUN_LEASE_SECONDS }).catch((error) =>
      log.warn({ err: error }, 'core turn reaper failed'),
    )
  }, 30_000),
)
timers.push(
  setInterval(() => {
    void cleanupExpiredSessions(ctx).catch((error) => log.warn({ err: error }, 'session cleanup failed'))
  }, 3_600_000),
)

await app.listen({ host: config.HOST, port: config.PORT })
log.info({ port: config.PORT, queue: config.QUEUE_DRIVER, github: github.mode, database: handle.kind }, 'api listening')

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'api shutting down')
  for (const timer of timers) clearInterval(timer)
  await coreLoop?.stop().catch(() => {})
  await wecomBot?.stop().catch(() => {})
  await app.close().catch(() => {})
  if (redis) await redis.close().catch(() => {})
  else await queue.close().catch(() => {})
  await handle.close().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (error) => log.error({ err: error }, 'unhandled rejection'))
