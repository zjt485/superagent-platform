import { createPrivateKey, sign } from 'node:crypto'
import type { Config } from '../config.js'
import type { Logger } from '../logger.js'
import type { GitHubPort, InstallationAccount, PullRequestInput, PullRequestResult, RepoInfo } from '../domain/github.js'
import { AppError } from '../errors.js'

type Json = Record<string, unknown>
const asRecord = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {})
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

interface CachedToken {
  token: string
  expiresAt: number
}

export class GithubAppClient implements GitHubPort {
  readonly mode = 'app' as const
  private jwtCache: { value: string; expiresAt: number } | null = null
  private readonly tokens = new Map<string, CachedToken>()
  private readonly privateKey: ReturnType<typeof createPrivateKey>

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    if (!config.GITHUB_APP_ID) throw new Error('GITHUB_APP_ID is required')
    const pem = (config.GITHUB_APP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n')
    this.privateKey = createPrivateKey(pem)
  }

  private appJwt(): string {
    if (this.jwtCache && this.jwtCache.expiresAt > Date.now() + 30_000) return this.jwtCache.value
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.config.GITHUB_APP_ID })).toString('base64url')
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), this.privateKey).toString('base64url')
    const value = `${header}.${payload}.${signature}`
    this.jwtCache = { value, expiresAt: Date.now() + 9 * 60_000 }
    return value
  }

  private async api<T>(path: string, init: RequestInit = {}, token?: string, allow404 = false): Promise<T> {
    const response = await this.fetchImpl(`${this.config.GITHUB_API_BASE}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'superagent-platform',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    })
    if (response.status === 404 && allow404) return {} as T
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new AppError(502, 'internal', `GitHub API ${path} failed with HTTP ${response.status}: ${text.slice(0, 300)}`)
    }
    return (await response.json().catch(() => ({}))) as T
  }

  async installationAccount(installationId: string): Promise<InstallationAccount> {
    const payload = await this.api<Json>(`/app/installations/${encodeURIComponent(installationId)}`, {}, this.appJwt())
    const account = asRecord(payload.account)
    return { login: asString(account.login) ?? '', type: asString(account.type) ?? 'User' }
  }

  async installationToken(installationId: string): Promise<string> {
    const cached = this.tokens.get(installationId)
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
    const payload = await this.api<Json>(
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      { method: 'POST' },
      this.appJwt(),
    )
    const token = asString(payload.token)
    if (!token) throw new AppError(502, 'internal', 'GitHub did not return an installation token')
    const expiresAt = Date.parse(asString(payload.expires_at) ?? '') || Date.now() + 50 * 60_000
    this.tokens.set(installationId, { token, expiresAt })
    this.log.debug({ installationId }, 'refreshed GitHub installation token')
    return token
  }

  async installationRepos(installationId: string): Promise<RepoInfo[]> {
    const token = await this.installationToken(installationId)
    const payload = await this.api<Json>('/installation/repositories?per_page=100', {}, token)
    return asArray(payload.repositories).map((item) => {
      const repo = asRecord(item)
      const owner = asRecord(repo.owner)
      return {
        owner: asString(owner.login) ?? '',
        name: asString(repo.name) ?? '',
        fullName: asString(repo.full_name) ?? '',
        defaultBranch: asString(repo.default_branch) ?? 'main',
        private: Boolean(repo.private),
      }
    })
  }

  async repoInfo(installationId: string, owner: string, name: string): Promise<RepoInfo> {
    const token = await this.installationToken(installationId)
    const repo = await this.api<Json>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {}, token)
    return {
      owner: asString(asRecord(repo.owner).login) ?? owner,
      name: asString(repo.name) ?? name,
      fullName: asString(repo.full_name) ?? `${owner}/${name}`,
      defaultBranch: asString(repo.default_branch) ?? 'main',
      private: Boolean(repo.private),
    }
  }

  async createPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const token = await this.installationToken(input.installationId)
    const payload = await this.api<Json>(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({ head: input.head, base: input.base, title: input.title, body: input.body, draft: false }),
        headers: { 'content-type': 'application/json' },
      },
      token,
    )
    const url = asString(payload.html_url)
    const number = Number(payload.number ?? 0)
    if (!url) throw new AppError(502, 'internal', 'GitHub did not return a pull request URL')
    return { url, number }
  }

  remoteUrl(fullName: string): string {
    return `${this.config.GITHUB_WEB_BASE}/${fullName}.git`
  }

  installUrl(state: string): string {
    const slug = this.config.GITHUB_APP_SLUG
    if (!slug) throw new AppError(500, 'internal', 'GITHUB_APP_SLUG is required for the install flow')
    return `${this.config.GITHUB_WEB_BASE}/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`
  }
}

export class MockGithubClient implements GitHubPort {
  readonly mode = 'mock' as const

  constructor(private readonly config: Config) {}

  async installationAccount(installationId: string): Promise<InstallationAccount> {
    return { login: 'demo-org', type: 'Organization' }
  }

  async installationRepos(installationId: string): Promise<RepoInfo[]> {
    return [
      { owner: 'demo-org', name: 'hello-world', fullName: 'demo-org/hello-world', defaultBranch: 'main', private: false },
      { owner: 'demo-org', name: 'web-console', fullName: 'demo-org/web-console', defaultBranch: 'main', private: true },
    ]
  }

  async repoInfo(installationId: string, owner: string, name: string): Promise<RepoInfo> {
    return { owner, name, fullName: `${owner}/${name}`, defaultBranch: 'main', private: false }
  }

  async installationToken(installationId: string): Promise<string> {
    return 'mock-installation-token'
  }

  async createPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const number = 100 + Math.floor(Math.random() * 900)
    return { number, url: `${this.config.GITHUB_WEB_BASE}/${input.owner}/${input.name}/pull/${number}` }
  }

  remoteUrl(fullName: string): string {
    return `${this.config.GITHUB_WEB_BASE}/${fullName}.git`
  }

  installUrl(state: string): string {
    return `${this.config.PUBLIC_BASE_URL}/v1/github/install/callback?installation_id=1&state=${encodeURIComponent(state)}`
  }
}
