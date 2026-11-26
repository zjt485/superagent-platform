import type { Config } from '../config.js'
import type { Database } from '../db/client.js'
import type { Logger } from '../logger.js'
import { defaultEventBus, type ProjectEventBus } from './events.js'

/**
 * Dependencies shared by services. `now` and id generation are injected so
 * tests can be deterministic without mocking modules.
 */
export interface Deps {
  config: Config
  db: Database
  log: Logger
  now: () => Date
  events?: ProjectEventBus
}

export const systemNow = (): Date => new Date()

export function depsOf(input: {
  config: Config
  db: Database
  log: Logger
  now?: () => Date
  events?: ProjectEventBus
}): Deps {
  return {
    config: input.config,
    db: input.db,
    log: input.log,
    now: input.now ?? systemNow,
    events: input.events ?? defaultEventBus,
  }
}
