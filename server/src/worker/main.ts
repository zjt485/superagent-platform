import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { githubMode, loadConfig } from '../config.js'
import { openDatabase } from '../db/client.js'
import { createLogger } from '../logger.js'
import { depsOf } from '../services/deps.js'
import { createDbQueue, createRedisQueue, RUN_QUEUE_NAME } from '../queue/index.js'
import { createGithub } from '../github/index.js'
import { createRuntime } from '../runtime/index.js'
import { claimNextRun, claimRunById } from '../services/runs.js'
import { executeClaimedRun, type WorkerContext } from './pipeline.js'
import { RealGitOps } from './git.js'
import { FakeGitOps } from './fake-git.js'
import { reapStaleRuns } from '../services/orchestrator.js'

const config = loadConfig()
const log = createLogger(config, { role: 'worker' })
const handle = await openDatabase(config)
const deps = depsOf({ config, db: handle.db, log })
const workerId = config.WORKER_ID ?? `${hostname()}-${randomUUID().slice(0, 8)}`
const redis = config.QUEUE_DRIVER === 'redis' ? createRedisQueue(config, log) : null
const queue = redis?.queue ?? createDbQueue()

const ctx: WorkerContext = {
  ...deps,
  queue,
  ports: {
    github: createGithub(config, log),
    git: githubMode(config) === 'mock' ? new FakeGitOps() : new RealGitOps(),
    runtime: createRuntime(config, log),
  },
}

let stopping = false
const inflight = new Set<Promise<unknown>>()

function track<T>(promise: Promise<T>): Promise<T> {
  inflight.add(promise)
  void promise.finally(() => inflight.delete(promise))
  return promise
}

async function execute(runId: string): Promise<void> {
  const run = await claimRunById(deps, runId, workerId)
  if (!run) return
  log.info({ runId: run.id, ticketId: run.ticketId, kind: run.kind }, 'run started')
  await executeClaimedRun(ctx, run)
}

async function pollLoop(index: number): Promise<void> {
  while (!stopping) {
    try {
      const run = await claimNextRun(deps, workerId)
      if (!run) {
        await sleep(config.WORKER_POLL_INTERVAL_MS)
        continue
      }
      log.info({ runId: run.id, ticketId: run.ticketId, kind: run.kind, loop: index }, 'run started')
      await track(executeClaimedRun(ctx, run))
    } catch (error) {
      log.error({ err: error }, 'worker loop error')
      await sleep(Math.max(config.WORKER_POLL_INTERVAL_MS, 1000))
    }
  }
}

let bullWorker: Worker | null = null
// BullMQ wants a dedicated blocking connection for the Worker; the Queue keeps
// its own connection. Sharing one ioredis instance between both can stall jobs.
const workerConnection = redis ? new Redis(config.REDIS_URL as string, { maxRetriesPerRequest: null }) : null
workerConnection?.on('error', (error) => log.warn({ err: error }, 'redis worker connection error'))
if (redis && workerConnection) {
  bullWorker = new Worker(
    RUN_QUEUE_NAME,
    async (job) => {
      await track(execute(String(job.data.runId)))
    },
    { connection: workerConnection, concurrency: config.WORKER_CONCURRENCY },
  )
  bullWorker.on('failed', (job, error) => log.error({ err: error, jobId: job?.id }, 'bullmq job failed'))
  bullWorker.on('error', (error) => log.warn({ err: error }, 'bullmq worker error'))
  // Orphan recovery: a run row may be queued without a live Redis job.
  setInterval(() => {
    if (stopping) return
    void claimNextRun(deps, workerId)
      .then((run) => (run ? track(executeClaimedRun(ctx, run)) : undefined))
      .catch((error) => log.warn({ err: error }, 'orphan poll failed'))
  }, 15_000)
} else {
  for (let index = 0; index < config.WORKER_CONCURRENCY; index += 1) {
    void pollLoop(index)
  }
}

const reaper = setInterval(() => {
  void reapStaleRuns(ctx).catch((error) => log.warn({ err: error }, 'reaper failed'))
}, 30_000)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log.info({ signal }, 'worker shutting down')
  clearInterval(reaper)
  if (bullWorker) await bullWorker.close().catch(() => {})
  await Promise.allSettled([...inflight])
  if (redis) await redis.close().catch(() => {})
  else await queue.close().catch(() => {})
  await workerConnection?.quit().catch(() => {})
  await handle.close().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (error) => log.error({ err: error }, 'unhandled rejection'))

log.info({ workerId, queue: config.QUEUE_DRIVER, runtime: ctx.ports.runtime.name, github: ctx.ports.github.mode }, 'worker started')
