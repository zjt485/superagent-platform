/** Standalone Router/Dispatcher worker for the unified core engine. */

import { githubMode, loadConfig } from './config.js'
import { loadLocalEnv } from './env.js'
import { createLogger } from './logger.js'
import { openDatabase } from './db/client.js'
import { createTurnRuntime } from './core/agent/runtime.js'
import { createGithub } from './github/index.js'
import { routerModelFromConfig } from './core/router/from-config.js'
import { GitDeliveryProvider } from './core/worker/delivery.js'
import { RuntimeExecutor } from './core/worker/runtime-executor.js'
import { createDbWorkspaceProvider } from './core/worker/workspace-provider.js'
import { startCoreLoop } from './core/worker/loop.js'
import { createSandboxProvider } from './core/sandbox/docker.js'
import { McpClient } from './core/mcp/client.js'
import { FakeGitOps } from './worker/fake-git.js'
import { RealGitOps } from './worker/git.js'

loadLocalEnv()
const config = loadConfig()
const log = createLogger(config, { role: 'core-worker' })
const handle = await openDatabase(config)

const github = createGithub(config, log)
const workspace = createDbWorkspaceProvider({
  db: handle.db,
  rootDir: config.WORKSPACES_DIR,
  github,
  webBase: config.GITHUB_WEB_BASE,
})
const delivery = new GitDeliveryProvider({
  db: handle.db,
  git: githubMode(config) === 'mock' ? new FakeGitOps() : new RealGitOps(),
  github,
  author: { name: config.GIT_AUTHOR_NAME, email: config.GIT_AUTHOR_EMAIL },
  webBase: config.GITHUB_WEB_BASE,
})

const loop = startCoreLoop({
  db: handle.db,
  model: routerModelFromConfig(config),
  executor: new RuntimeExecutor(createTurnRuntime(config, log)),
  workspace,
  delivery,
  sandbox: createSandboxProvider({
    rootDir: config.WORKSPACES_DIR,
    defaultDockerImage: config.SANDBOX_IMAGE,
  }),
  mcpClient: new McpClient(),
  artifactsRoot: config.WORKSPACES_DIR,
  now: () => new Date(),
  intervalMs: config.CORE_POLL_INTERVAL_MS,
  leaseSeconds: config.RUN_LEASE_SECONDS,
  log,
})
log.info({ workspaces: config.WORKSPACES_DIR }, 'core worker started')

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log.info({ signal }, 'core worker shutting down')
  await loop.stop().catch(() => {})
  await handle.close().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (error) => log.error({ err: error }, 'unhandled rejection'))
