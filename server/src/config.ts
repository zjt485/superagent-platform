import { z } from 'zod'

const boolean = (fallback: boolean) =>
  z
    .preprocess((value) => {
      if (value === undefined || value === null || value === '') return fallback
      if (typeof value === 'boolean') return value
      const text = String(value).toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(text)) return true
      if (['0', 'false', 'no', 'off'].includes(text)) return false
      return value
    }, z.boolean())

const integer = (fallback: number, min = 0) =>
  z.preprocess(
    (value) => (value === undefined || value === null || value === '' ? fallback : Number(value)),
    z.number().int().min(min),
  )

const optionalText = z
  .preprocess((value) => (value === undefined || value === null || value === '' ? undefined : String(value)), z.string().min(1).optional())

const decimal = (fallback: number, min = 0) =>
  z.preprocess(
    (value) => (value === undefined || value === null || value === '' ? fallback : Number(value)),
    z.number().min(min),
  )

const text = (fallback: string) =>
  z.preprocess((value) => (value === undefined || value === null || value === '' ? fallback : String(value)), z.string().min(1))

/**
 * Everything the deployment can configure. The schema is the single source of
 * truth for the README and .env.example; unknown variables are ignored so the
 * same process environment can serve several deployments.
 */
export const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    HOST: text('0.0.0.0'),
    PORT: integer(3000, 1),
    APP_NAME: text('Superagent'),
    PUBLIC_BASE_URL: text('http://localhost:3000').transform((value) => value.replace(/\/+$/, '')),

    // Persistence. With no DATABASE_URL the process uses an embedded PGlite
    // database on disk (development and demos); production points at Postgres.
    DATABASE_URL: optionalText,
    PGLITE_DIR: text('./data/pglite'),
    MIGRATE_ON_START: boolean(true),

    // Sessions and internal service authentication.
    SESSION_SECRET: text('development-only-session-secret-change-me'),
    SESSION_TTL_HOURS: integer(168, 1),
    INTERNAL_TOKEN: text('development-only-internal-token'),
    AUTH_DEV_LOGIN: boolean(true),
    PLATFORM_ADMIN_EXTERNAL_IDS: optionalText,

    // IM adapters.
    FEISHU_APP_ID: optionalText,
    FEISHU_APP_SECRET: optionalText,
    FEISHU_VERIFICATION_TOKEN: optionalText,
    FEISHU_ENCRYPT_KEY: optionalText,
    FEISHU_BOT_OPEN_ID: optionalText,
    FEISHU_API_BASE: text('https://open.feishu.cn'),
    FEISHU_OAUTH_REDIRECT_PATH: text('/v1/auth/feishu/callback'),

    WECOM_CORP_ID: optionalText,
    WECOM_AGENT_ID: optionalText,
    WECOM_SECRET: optionalText,
    WECOM_TOKEN: optionalText,
    WECOM_ENCODING_AES_KEY: optionalText,
    WECOM_API_BASE: text('https://qyapi.weixin.qq.com'),
    WECOM_OAUTH_REDIRECT_PATH: text('/v1/auth/wecom/callback'),
    WECOM_BOT_NAME: text('Superagent'),
    WECOM_BOT_ID: optionalText,
    WECOM_BOT_SECRET: optionalText,
    WECOM_BOT_WS_URL: optionalText,

    // GitHub App. Without credentials the deployment runs the mock GitHub
    // adapter (deterministic PR URLs) so the pipeline is demonstrable locally.
    GITHUB_APP_ID: optionalText,
    GITHUB_APP_SLUG: optionalText,
    GITHUB_APP_PRIVATE_KEY: optionalText,
    GITHUB_APP_PRIVATE_KEY_PATH: optionalText,
    GITHUB_WEBHOOK_SECRET: optionalText,
    GITHUB_API_BASE: text('https://api.github.com'),
    GITHUB_WEB_BASE: text('https://github.com'),
    GITHUB_MODE: z.enum(['auto', 'app', 'mock']).default('auto'),

    // Queue.
    QUEUE_DRIVER: z.enum(['db', 'redis']).default('db'),
    REDIS_URL: optionalText,
    WORKER_ID: optionalText,
    WORKER_CONCURRENCY: integer(1, 1),
    WORKER_POLL_INTERVAL_MS: integer(500, 50),
    RUN_LEASE_SECONDS: integer(120, 30),
    /**
     * Development/single-node convenience: run the core Router/Dispatcher loop
     * inside the API process. Never allowed in production; the control plane
     * must not execute repository code.
     */
    INLINE_WORKER: boolean(false),
    CORE_ROUTER: z.enum(['rule', 'llm']).default('rule'),
    CORE_POLL_INTERVAL_MS: integer(1000, 50),

    // Execution.
    WORKSPACES_DIR: text('./data/workspaces'),
    KEEP_WORKSPACES: boolean(false),
    AGENT_RUNTIME: z.enum(['fake', 'command', 'openai']).default('fake'),
    AGENT_COMMAND: optionalText,
    AGENT_TIMEOUT_MINUTES: integer(45, 1),

    // Direct OpenAI-compatible runtime. Used when AGENT_RUNTIME=openai.
    LLM_BASE_URL: text('https://api.deepseek.com/v1'),
    LLM_API_KEY: optionalText,
    LLM_MODEL: text('deepseek-chat'),
    LLM_TEMPERATURE: decimal(0.2, 0),
    LLM_MAX_OUTPUT_TOKENS: integer(4096, 256),
    LLM_MAX_STEPS: integer(20, 1),
    LLM_INPUT_COST_PER_1M: decimal(0, 0),
    LLM_OUTPUT_COST_PER_1M: decimal(0, 0),
    GIT_AUTHOR_NAME: text('Superagent'),
    GIT_AUTHOR_EMAIL: text('superagent@example.invalid'),

    // Notification sender.
    OUTBOX_INTERVAL_MS: integer(1000, 100),
    OUTBOX_BATCH_SIZE: integer(20, 1),
    OUTBOX_MAX_ATTEMPTS: integer(8, 1),

    // HTTP.
    RATE_LIMIT_WEBHOOK_MAX: integer(120, 1),
    SERVE_WEB: boolean(true),
    WEB_DIST_DIR: text('./public'),
    TRUST_PROXY: boolean(true),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return
    if (value.SESSION_SECRET.length < 32) {
      ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'SESSION_SECRET must be at least 32 characters in production' })
    }
    if (value.AUTH_DEV_LOGIN) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_DEV_LOGIN'], message: 'AUTH_DEV_LOGIN must be disabled in production' })
    }
    if (value.QUEUE_DRIVER === 'redis' && !value.REDIS_URL) {
      ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'REDIS_URL is required when QUEUE_DRIVER=redis' })
    }
    if (value.INLINE_WORKER && value.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['INLINE_WORKER'],
        message: 'INLINE_WORKER is only for development; run the worker service in production',
      })
    }
  })

export type Config = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env)
}

/** True when the deployment can talk to the real GitHub API. */
export function hasGithubApp(config: Config): boolean {
  return Boolean(config.GITHUB_APP_ID && (config.GITHUB_APP_PRIVATE_KEY || config.GITHUB_APP_PRIVATE_KEY_PATH))
}

export function githubMode(config: Config): 'app' | 'mock' {
  if (config.GITHUB_MODE === 'mock') return 'mock'
  if (config.GITHUB_MODE === 'app') return 'app'
  return hasGithubApp(config) ? 'app' : 'mock'
}

export function hasFeishu(config: Config): boolean {
  return Boolean(config.FEISHU_APP_ID && config.FEISHU_APP_SECRET)
}

export function hasWecom(config: Config): boolean {
  return Boolean(config.WECOM_CORP_ID && config.WECOM_SECRET)
}

export function hasWecomBot(config: Config): boolean {
  return Boolean(config.WECOM_BOT_ID && config.WECOM_BOT_SECRET)
}
