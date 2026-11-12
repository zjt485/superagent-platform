import type { FastifyInstance } from 'fastify'
import { count, eq, sql } from 'drizzle-orm'
import type { AppContext } from '../context.js'
import { outboxEvents, runs, tickets } from '../../db/schema.js'

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/healthz', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round((Date.now() - ctx.startedAt.getTime()) / 1000),
    version: process.env.npm_package_version ?? '0.1.0',
  }))

  app.get('/readyz', async (request, reply) => {
    try {
      await ctx.db.execute(sql`select 1`)
      return { status: 'ok', database: 'ok' }
    } catch (error) {
      request.log.error({ err: error }, 'readiness check failed')
      reply.code(503)
      return { status: 'degraded', database: 'unavailable' }
    }
  })

  app.get('/metrics', async (request, reply) => {
    const [runRows, ticketRows, [pending]] = await Promise.all([
      ctx.db.select({ status: runs.status, value: count() }).from(runs).groupBy(runs.status),
      ctx.db.select({ status: tickets.status, value: count() }).from(tickets).groupBy(tickets.status),
      ctx.db.select({ value: count() }).from(outboxEvents).where(eq(outboxEvents.status, 'pending')),
    ])
    const lines = [
      '# HELP superagent_runs_total Runs by status.',
      '# TYPE superagent_runs_total gauge',
      ...runRows.map((row) => `superagent_runs_total{status="${row.status}"} ${Number(row.value)}`),
      '# HELP superagent_tickets_total Tickets by status.',
      '# TYPE superagent_tickets_total gauge',
      ...ticketRows.map((row) => `superagent_tickets_total{status="${row.status}"} ${Number(row.value)}`),
      '# HELP superagent_outbox_pending Pending notification deliveries.',
      '# TYPE superagent_outbox_pending gauge',
      `superagent_outbox_pending ${Number(pending?.value ?? 0)}`,
      '# HELP superagent_up Whether the control plane is up.',
      '# TYPE superagent_up gauge',
      'superagent_up 1',
      '',
    ]
    reply.type('text/plain; version=0.0.4; charset=utf-8')
    return lines.join('\n')
  })
}
