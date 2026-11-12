import type { Config } from '../config.js'
import type { Database } from '../db/client.js'
import type { Logger } from '../logger.js'

/**
 * Dependencies shared by services. `now` and id generation are injected so
 * tests can be deterministic without mocking modules.
 */
export interface Deps {
  config: Config
  db: Database
  log: Logger
  now: () => Date
}

export const systemNow = (): Date => new Date()

export function depsOf(input: { config: Config; db: Database; log: Logger; now?: () => Date }): Deps {
  return { config: input.config, db: input.db, log: input.log, now: input.now ?? systemNow }
}
