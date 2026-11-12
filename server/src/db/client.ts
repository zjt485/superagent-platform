import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import postgres from 'postgres'
import type { Config } from '../config.js'
import * as schema from './schema.js'

/**
 * Repository code depends on this structural type, so the same repositories
 * run on embedded PGlite (development, tests, single-node demo) and on
 * Postgres 16 (deployments). The query-result generic is intentionally `any`:
 * both drivers implement the same builder surface.
 */
export type Database = PgDatabase<any, typeof schema>

export interface DatabaseHandle {
  db: Database
  kind: 'postgres' | 'pglite'
  migrate(): Promise<void>
  close(): Promise<void>
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url))

export interface OpenDatabaseOptions {
  /** Use an in-memory PGlite instance (tests, one-off scripts). */
  memory?: boolean
  /** Run pending migrations after connecting. Defaults to config.MIGRATE_ON_START. */
  migrate?: boolean
}

export async function openDatabase(config: Config, options: OpenDatabaseOptions = {}): Promise<DatabaseHandle> {
  if (config.DATABASE_URL && !options.memory) {
    const client = postgres(config.DATABASE_URL, { max: 10, onnotice: () => {} })
    const db = drizzlePostgres(client, { schema }) as unknown as Database
    const handle: DatabaseHandle = {
      db,
      kind: 'postgres',
      async migrate() {
        await migratePostgres(db as never, { migrationsFolder: MIGRATIONS_FOLDER })
      },
      async close() {
        await client.end({ timeout: 5 })
      },
    }
    if (options.migrate ?? config.MIGRATE_ON_START) await handle.migrate()
    return handle
  }

  if (!options.memory) await mkdir(config.PGLITE_DIR, { recursive: true })
  const embedded = options.memory ? new PGlite() : new PGlite(config.PGLITE_DIR)
  await embedded.waitReady
  const db = drizzlePglite(embedded, { schema }) as unknown as Database
  const handle: DatabaseHandle = {
    db,
    kind: 'pglite',
    async migrate() {
      await migratePglite(db as never, { migrationsFolder: MIGRATIONS_FOLDER })
    },
    async close() {
      await embedded.close()
    },
  }
  if (options.migrate ?? config.MIGRATE_ON_START) await handle.migrate()
  return handle
}
