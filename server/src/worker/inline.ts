import { claimNextRun } from '../services/runs.js'
import { executeClaimedRun, type WorkerContext } from './pipeline.js'

export interface InlineWorker {
  stop(): Promise<void>
}

/**
 * Development-only worker loop that shares the API process. It exists so a
 * single Node process can exercise the full intake → plan → PR pipeline while
 * testing IM webhooks locally. Production still runs `worker-main`.
 */
export function startInlineWorker(ctx: WorkerContext, workerId: string): InlineWorker {
  let stopping = false
  const inflight = new Set<Promise<unknown>>()

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const loop = async (): Promise<void> => {
    ctx.log.warn({ workerId }, 'inline worker enabled (development only)')
    while (!stopping) {
      try {
        const run = await claimNextRun(ctx, workerId)
        if (!run) {
          await sleep(ctx.config.WORKER_POLL_INTERVAL_MS)
          continue
        }
        ctx.log.info({ runId: run.id, ticketId: run.ticketId, kind: run.kind }, 'inline worker claimed run')
        const task = executeClaimedRun(ctx, run)
        inflight.add(task)
        try {
          await task
        } finally {
          inflight.delete(task)
        }
      } catch (error) {
        ctx.log.error({ err: error }, 'inline worker loop error')
        await sleep(1000)
      }
    }
  }
  const loopPromise = loop()

  return {
    async stop() {
      stopping = true
      await Promise.allSettled([...inflight])
      await loopPromise
    },
  }
}
