import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import type { Config } from '../config.js'
import type { QueuePort } from '../domain/queue.js'
import type { Logger } from '../logger.js'

export const RUN_QUEUE_NAME = 'superagent-runs'

/** The database row is the queue: workers poll it, so `notify` is a hint only. */
export function createDbQueue(): QueuePort {
  return {
    driver: 'db',
    async notify() {},
    async close() {},
  }
}

export interface RedisQueueHandle {
  queue: QueuePort
  connection: Redis
  close(): Promise<void>
}

export function createRedisQueue(config: Config, log: Logger): RedisQueueHandle {
  if (!config.REDIS_URL) throw new Error('REDIS_URL is required for the redis queue driver')
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })
  connection.on('error', (error) => log.warn({ err: error }, 'redis queue connection error'))
  // BullMQ requires this option on user-provided ioredis connections.
  const queue = new Queue(RUN_QUEUE_NAME, { connection })
  return {
    connection,
    queue: {
      driver: 'redis',
      async notify(runId: string) {
        await queue.add(
          'run',
          { runId },
          {
            jobId: runId,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: 100,
          },
        )
        log.debug({ runId }, 'queued redis run job')
      },
      async close() {
        await queue.close()
      },
    },
    async close() {
      await queue.close()
      await connection.quit()
    },
  }
}
