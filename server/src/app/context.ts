import type { Config } from '../config.js'
import type { Database } from '../db/client.js'
import type { Logger } from '../logger.js'
import type { QueuePort } from '../domain/queue.js'
import type { ImRegistry } from '../domain/im.js'
import type { OAuthRegistry } from '../domain/oauth.js'
import type { GitHubPort } from '../domain/github.js'
import type { OutboxSender } from '../services/outbox.js'
import type { ChannelProvider } from '../domain/status.js'

/** Everything an HTTP handler may reach; built once in the API entrypoint. */
export interface AppContext {
  config: Config
  db: Database
  log: Logger
  now: () => Date
  queue: QueuePort
  im: ImRegistry
  oauth: OAuthRegistry
  github: GitHubPort
  senders: Map<ChannelProvider, OutboxSender>
  startedAt: Date
}
