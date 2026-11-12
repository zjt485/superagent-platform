import type { Config } from '../config.js'
import type { Logger } from '../logger.js'
import { FakeRuntime } from './fake.js'
import { ProcessRuntime } from './process.js'
import type { AgentRuntime } from '../domain/runtime.js'

export function createRuntime(config: Config, log: Logger): AgentRuntime {
  if (config.AGENT_RUNTIME === 'command') {
    if (!config.AGENT_COMMAND) throw new Error('AGENT_COMMAND is required when AGENT_RUNTIME=command')
    return new ProcessRuntime({ command: config.AGENT_COMMAND })
  }
  if (config.NODE_ENV === 'production') {
    log.warn('fake agent runtime is enabled in production; no real code changes will be produced')
  }
  return new FakeRuntime()
}
