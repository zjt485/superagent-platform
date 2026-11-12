import { claimNextTurn } from './sessions.js'
import { executeTurn, type DualWorkerContext } from './worker.js'

export interface InlineWorker {
  stop(): Promise<void>
}

/**
 * Development-only worker loop sharing the API process. Production runs the
 * separate worker service; this exists for local IM/tunnel testing.
 */
export function startInlineWorker(ctx: DualWorkerContext, workerId: string): InlineWorker {
  let stopping = false
  const inflight = new Set<Promise<unknown>>()
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const loop = async (): Promise<void> => {
    ctx.log.warn({ workerId }, 'inline dual-agent worker enabled (development only)')
    while (!stopping) {
      try {
        const turn = await claimNextTurn(ctx, workerId)
        if (!turn) {
          await sleep(ctx.config.WORKER_POLL_INTERVAL_MS)
          continue
        }
        ctx.log.info({ turnId: turn.id, kind: turn.kind, ticketId: turn.ticketId }, 'inline worker claimed turn')
        const task = executeTurn(ctx, turn)
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
