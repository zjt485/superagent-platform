import type { Database } from '../../db/client.js'
import type { Logger } from '../../logger.js'
import type { RouterModel } from '../router/model.js'
import { dispatchOnce } from './dispatcher.js'
import type { DeliveryProvider } from './delivery.js'
import type { Executor } from './executor.js'
import type { WorkspaceProvider } from './workspace-provider.js'
import { coreTick } from './tick.js'

export interface CoreLoopOptions {
  db: Database
  model: RouterModel
  executor: Executor
  now: () => Date
  intervalMs?: number
  maxRounds?: number
  workspace?: WorkspaceProvider
  delivery?: DeliveryProvider
  timeoutMs?: number
  env?: Record<string, string>
  log?: Logger
}

export interface CoreLoop {
  stop(): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Run Router sweeps and dispatch queued turns until stopped. */
export function startCoreLoop(options: CoreLoopOptions): CoreLoop {
  let stopping = false
  let completed = false
  const intervalMs = options.intervalMs ?? 1000

  const loop = async (): Promise<void> => {
    while (!stopping) {
      try {
        const routed = await coreTick({ db: options.db, model: options.model, now: options.now, maxThreads: 10 })
        let dispatched = 0
        while (!stopping && (await dispatchOnce({ db: options.db, executor: options.executor, now: options.now, ...(options.workspace === undefined ? {} : { workspace: options.workspace }), ...(options.delivery === undefined ? {} : { delivery: options.delivery }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.env === undefined ? {} : { env: options.env }) }))) {
          dispatched += 1
          if (options.maxRounds !== undefined && dispatched >= options.maxRounds) break
        }
        if (routed.threads === 0 && dispatched === 0) await sleep(intervalMs)
      } catch (error) {
        options.log?.error({ err: error }, 'core worker loop error')
        await sleep(intervalMs)
      }
    }
  }

  const promise = loop().finally(() => {
    completed = true
  })

  return {
    async stop() {
      stopping = true
      if (!completed) await promise
    },
  }
}
