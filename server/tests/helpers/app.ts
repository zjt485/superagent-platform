import { afterEach, describe, expect, it } from 'vitest'
import { configSchema, type Config } from '../../src/config.js'
import { openDatabase, type DatabaseHandle } from '../../src/db/client.js'
import { createLogger } from '../../src/logger.js'
import { createDbQueue } from '../../src/queue/index.js'
import { MockGithubClient } from '../../src/github/client.js'
import { buildApp } from '../../src/app/build.js'
import type { AppContext } from '../../src/app/context.js'
import type { ChannelProvider } from '../../src/domain/status.js'
import type { OutboxSender } from '../../src/services/outbox.js'

export function testConfig(overrides: Record<string, unknown> = {}): Config {
  return configSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    INTERNAL_TOKEN: 'test-internal-token',
    AUTH_DEV_LOGIN: true,
    QUEUE_DRIVER: 'db',
    AGENT_RUNTIME: 'fake',
    GITHUB_MODE: 'mock',
    MIGRATE_ON_START: true,
    SERVE_WEB: false,
    FEISHU_VERIFICATION_TOKEN: 'test-verification-token',
    FEISHU_ENCRYPT_KEY: 'test-encrypt-key-0123456789abcdef',
    FEISHU_BOT_OPEN_ID: 'ou_bot',
    WECOM_TOKEN: 'test-wecom-token',
    WECOM_CORP_ID: 'ww_test_corp',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    ...overrides,
  })
}

export interface Harness {
  config: Config
  handle: DatabaseHandle
  ctx: AppContext
  app: Awaited<ReturnType<typeof buildApp>>
  close(): Promise<void>
}

export async function createHarness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const config = testConfig(overrides)
  const handle = await openDatabase(config, { memory: true, migrate: true })
  const log = createLogger(config)
  const ctx: AppContext = {
    config,
    db: handle.db,
    log,
    now: () => new Date(),
    queue: createDbQueue(),
    im: {},
    oauth: {},
    github: new MockGithubClient(config),
    senders: new Map<ChannelProvider, OutboxSender>(),
    startedAt: new Date(),
  }
  const app = await buildApp(ctx)
  return {
    config,
    handle,
    ctx,
    app,
    async close() {
      await app.close()
      await handle.close()
    },
  }
}

export function cookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie']
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const session = values.find((value: string) => value.startsWith('sa_session='))
  if (!session) throw new Error(`no session cookie in ${JSON.stringify(values)}`)
  return session.split(';')[0] as string
}

export interface ApiOptions {
  cookie?: string
  body?: unknown
  headers?: Record<string, string>
  csrf?: boolean
}

export async function api(
  harness: Harness,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: ApiOptions = {},
): Promise<{ status: number; json: any; headers: Record<string, unknown>; body: string }> {
  const headers: Record<string, string> = { ...options.headers }
  if (options.cookie) headers.cookie = options.cookie
  if (method !== 'GET' && options.csrf !== false) headers['x-superagent-csrf'] = '1'
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const response = await harness.app.inject({
    method,
    url,
    headers,
    ...(options.body === undefined ? {} : { payload: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
  })
  let json: unknown = null
  try {
    json = response.body ? JSON.parse(response.body) : null
  } catch {
    json = null
  }
  return { status: response.statusCode, json: json as any, headers: response.headers as Record<string, unknown>, body: response.body }
}

export const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop()
    if (fn) await fn()
  }
})
