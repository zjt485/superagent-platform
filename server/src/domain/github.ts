export interface RepoInfo {
  owner: string
  name: string
  fullName: string
  defaultBranch: string
  private: boolean
}

export interface InstallationAccount {
  login: string
  type: string
}

export interface PullRequestInput {
  installationId: string
  owner: string
  name: string
  head: string
  base: string
  title: string
  body: string
}

export interface PullRequestResult {
  number: number
  url: string
}

/**
 * GitHub App port (§7.2): installation-scoped, short-lived tokens, one repo per
 * project. The mock implementation keeps the whole pipeline demonstrable
 * without credentials.
 */
export interface GitHubPort {
  mode: 'app' | 'mock'
  installationRepos(installationId: string): Promise<RepoInfo[]>
  installationAccount(installationId: string): Promise<InstallationAccount>
  repoInfo(installationId: string, owner: string, name: string): Promise<RepoInfo>
  installationToken(installationId: string): Promise<string>
  createPullRequest(input: PullRequestInput): Promise<PullRequestResult>
  remoteUrl(fullName: string): string
  installUrl(state: string): string
}
