import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { githubMode, loadConfig } from './config.js'
import { loadLocalEnv } from './env.js'
import { createLogger } from './logger.js'
import { openDatabase } from './db/client.js'
import { createDbQueue, createRedisQueue } from './queue/index.js'
import { createGithub } from './github/index.js'
import { createIm } from './im/index.js'
import { buildApp } from './app/build.js'
import type { AppContext } from './app/context.js'
import { depsOf } from './services/deps.js'
import { flushOutbox } from './services/outbox.js'
import { cleanupExpiredSessions } from './services/auth.js'
import { reapStaleTurns } from './dual/engine.js'
import { startInlineWorker } from './dual/inline.js'
import type { DualWorkerContext } from './dual/worker.js'
import { createTurnRuntime } from './dual/runtime.js'
import { RealGitOps } from './worker/git.js'
import { FakeGitOps } from './worker/fake-git.js'

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

const app = await buildApp(ctx)

const inlineWorker = config.INLINE_WORKER
  ? startInlineWorker(
      {
        ...deps,
        queue,
        ports: {
          github,
          git: githubMode(config) === 'mock' ? new FakeGitOps() : new RealGitOps(),
          runtime: createTurnRuntime(config, log),
        },
      } satisfies DualWorkerContext,
      `inline-${hostname()}-${randomUUID().slice(0, 8)}`,
    )
  : null

const timers: NodeJS.Timeout[] = []
timers.push(
  setInterval(() => {
    void flushOutbox(ctx, ctx.senders, config.OUTBOX_BATCH_SIZE).catch((error) => log.warn({ err: error }, 'outbox flush failed'))
  }, config.OUTBOX_INTERVAL_MS),
)
timers.push(setInterval(() => {
  void reapStaleTurns({ ...ctx, queue }).catch((error) => log.warn({ err: error }, 'turn reaper failed'))
}, 30_000))
timers.push(setInterval(() => {
  void cleanupExpiredSessions(ctx).catch((error) => log.warn({ err: error }, 'session cleanup failed'))
}, 3_600_000))

await app.listen({ host: config.HOST, port: config.PORT })
log.info({ port: config.PORT, queue: config.QUEUE_DRIVER, github: github.mode, database: handle.kind }, 'api listening')

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'api shutting down')
  for (const timer of timers) clearInterval(timer)
  await inlineWorker?.stop().catch(() => {})
  await app.close().catch(() => {})
  if (redis) await redis.close().catch(() => {})
  else await queue.close().catch(() => {})
  await handle.close().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (error) => log.error({ err: error }, 'unhandled rejection'))
