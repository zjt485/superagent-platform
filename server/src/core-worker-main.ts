/** Standalone Router/Dispatcher worker for CORE_ENABLED deployments. */

import { githubMode, loadConfig } from './config.js'
import { loadLocalEnv } from './env.js'
import { createLogger } from './logger.js'
import { openDatabase } from './db/client.js'
import { repos } from './db/schema.js'
import { createTurnRuntime } from './dual/runtime.js'
import { createGithub } from './github/index.js'
import { RuleBasedRouterModel } from './core/router/model.js'
import { GitDeliveryProvider } from './core/worker/delivery.js'
import { RuntimeExecutor } from './core/worker/runtime-executor.js'
import { GitWorkspaceProvider } from './core/worker/workspace-provider.js'
import { startCoreLoop } from './core/worker/loop.js'
import { FakeGitOps } from './worker/fake-git.js'
import { RealGitOps, gitAuthEnv } from './worker/git.js'

loadLocalEnv()
const config = loadConfig()
const log = createLogger(config, { role: 'core-worker' })
const handle = await openDatabase(config)

const repoRows = await handle.db.select().from(repos)
const fullNameByProject = new Map(repoRows.map((repo) => [repo.projectId, repo.fullName]))
const token = process.env.GITHUB_TOKEN
const env = token === undefined ? {} : gitAuthEnv(token, config.GITHUB_WEB_BASE)
const workspace = new GitWorkspaceProvider({
  rootDir: config.WORKSPACES_DIR,
  remoteUrl: (project) => {
    const fullName = fullNameByProject.get(project.id)
    if (fullName === undefined) throw new Error(`project ${project.id} has no bound repository`)
    return `${config.GITHUB_WEB_BASE}/${fullName}.git`
  },
  env,
})

const github = createGithub(config, log)
const delivery = new GitDeliveryProvider({
  db: handle.db,
  git: githubMode(config) === 'mock' ? new FakeGitOps() : new RealGitOps(),
  github,
  author: { name: config.GIT_AUTHOR_NAME, email: config.GIT_AUTHOR_EMAIL },
  webBase: config.GITHUB_WEB_BASE,
})

const loop = startCoreLoop({
  db: handle.db,
  model: new RuleBasedRouterModel(),
  executor: new RuntimeExecutor(createTurnRuntime(config, log)),
  workspace,
  delivery,
  now: () => new Date(),
  intervalMs: config.CORE_POLL_INTERVAL_MS,
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
