/** Minimal queue abstraction: the DB driver only needs a nudge, BullMQ adds a job. */
export interface QueuePort {
  driver: 'db' | 'redis'
  notify(runId: string): Promise<void>
  close(): Promise<void>
}
