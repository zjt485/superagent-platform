import { readFileSync } from 'node:fs'
import { githubMode, type Config } from '../config.js'
import type { Logger } from '../logger.js'
import type { GitHubPort } from '../domain/github.js'
import { GithubAppClient, MockGithubClient } from './client.js'

export function createGithub(config: Config, log: Logger, fetchImpl: typeof fetch = globalThis.fetch): GitHubPort {
  const mode = githubMode(config)
  if (mode === 'mock') {
    if (config.NODE_ENV === 'production') {
      log.warn('GitHub is running in mock mode in production; PRs are simulated')
    }
    return new MockGithubClient(config)
  }
  let privateKey = config.GITHUB_APP_PRIVATE_KEY
  if (!privateKey && config.GITHUB_APP_PRIVATE_KEY_PATH) {
    privateKey = readFileSync(config.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8')
  }
  if (!privateKey) throw new Error('GitHub App private key is required (GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH)')
  return new GithubAppClient({ ...config, GITHUB_APP_PRIVATE_KEY: privateKey }, log, fetchImpl)
}
