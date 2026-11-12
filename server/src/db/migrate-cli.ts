import { loadConfig } from '../config.js'
import { loadLocalEnv } from '../env.js'
import { createLogger } from '../logger.js'
import { openDatabase } from './client.js'

loadLocalEnv()
const config = loadConfig()
const logger = createLogger(config, { scope: 'migrate' })
const handle = await openDatabase(config)
logger.info({ driver: handle.kind }, 'migrations applied')
await handle.close()
