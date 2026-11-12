import pino from 'pino'
import type { Config } from './config.js'

export type Logger = pino.Logger

export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV' | 'APP_NAME'>, bindings: Record<string, unknown> = {}): Logger {
  return pino({
    name: config.APP_NAME,
    level: config.LOG_LEVEL,
    base: { service: config.APP_NAME, env: config.NODE_ENV, ...bindings },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.token',
        '*.secret',
        '*.privateKey',
        'password',
      ],
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  })
}
