import type { Database } from '../../db/client.js'
import type { Logger } from '../../logger.js'
import type { ProjectEventBus } from '../../services/events.js'
import type { McpClient } from '../mcp/client.js'
import type { RouterModel } from '../router/model.js'
import { tickRoutines } from '../routines/scheduler.js'
import type { SandboxProvider } from '../sandbox/provider.js'
import { dispatchOnce } from './dispatcher.js'
import type { DeliveryProvider } from './delivery.js'
import type { Executor } from './executor.js'
import { reapStaleCoreTurns } from './reaper.js'
import type { WorkspaceProvider } from './workspace-provider.js'
import { coreTick } from './tick.js'

export interface CoreLoopOptions {
  db: Database
  model: RouterModel
  executor: Executor
  now: () => Date
  intervalMs?: number
  maxRounds?: number
  leaseSeconds?: number
  reapIntervalMs?: number
  routineIntervalMs?: number
  workspace?: WorkspaceProvider
  delivery?: DeliveryProvider
  sandbox?: SandboxProvider
  mcpClient?: McpClient
  artifactsRoot?: string
  timeoutMs?: number
  heartbeatMs?: number
  env?: Record<string, string>
  events?: ProjectEventBus
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
  const reapIntervalMs = options.reapIntervalMs ?? 30_000
  const routineIntervalMs = options.routineIntervalMs ?? 15_000
  let lastReapAt = 0
  let lastRoutineAt = 0

  const loop = async (): Promise<void> => {
    while (!stopping) {
      try {
        const nowMs = options.now().getTime()
        if (options.leaseSeconds !== undefined && nowMs - lastReapAt >= reapIntervalMs) {
          lastReapAt = nowMs
          await reapStaleCoreTurns({ db: options.db, now: options.now, leaseSeconds: options.leaseSeconds })
        }
        if (nowMs - lastRoutineAt >= routineIntervalMs) {
          lastRoutineAt = nowMs
          await tickRoutines({
            db: options.db,
            now: options.now,
            ...(options.events ? { events: options.events } : {}),
          })
        }
        const routed = await coreTick({
          db: options.db,
          model: options.model,
          now: options.now,
          maxThreads: 10,
          ...(options.log ? { log: options.log } : {}),
        })
        if (routed.runs > 0 || routed.errors > 0) {
          options.log?.info(routed, 'core router sweep')
        }
        let dispatched = 0
        while (
          !stopping &&
          (await dispatchOnce({
            db: options.db,
            executor: options.executor,
            now: options.now,
            ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
            ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
            ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
            ...(options.mcpClient === undefined ? {} : { mcpClient: options.mcpClient }),
            ...(options.artifactsRoot === undefined ? {} : { artifactsRoot: options.artifactsRoot }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(options.events === undefined ? {} : { events: options.events }),
            ...(options.log === undefined ? {} : { log: options.log }),
          }))
        ) {
          dispatched += 1
          options.log?.info({ dispatched }, 'core executor turn completed')
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
