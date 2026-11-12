import { configSchema, type Config } from '../../src/config.js'
import { openDatabase, type DatabaseHandle } from '../../src/db/client.js'

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
    FEISHU_VERIFICATION_TOKEN: 'test-verification-token',
    FEISHU_ENCRYPT_KEY: 'test-encrypt-key-0123456789abcdef',
    WECOM_TOKEN: 'test-wecom-token',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    ...overrides,
  })
}

export async function openTestDatabase(config: Config = testConfig()): Promise<DatabaseHandle> {
  return openDatabase(config, { memory: true, migrate: true })
}
