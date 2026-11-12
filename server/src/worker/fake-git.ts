import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { GitCloneInput, GitCommitInput, GitOps } from './git.js'

/** In-memory git for mock mode, demos and tests: files still change on disk. */
export class FakeGitOps implements GitOps {
  readonly pushed: { dir: string; branch: string }[] = []
  readonly committed: { dir: string; branch: string; message: string }[] = []

  async clone(input: GitCloneInput): Promise<void> {
    await mkdir(path.join(input.dir, '.git'), { recursive: true })
    await writeFile(path.join(input.dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
    await writeFile(path.join(input.dir, 'README.md'), '# demo repository\n', 'utf8')
  }

  async createBranchAndCommit(input: GitCommitInput): Promise<boolean> {
    this.committed.push({ dir: input.dir, branch: input.branch, message: input.message })
    return true
  }

  async push(input: { dir: string; branch: string; env: Record<string, string> }): Promise<void> {
    this.pushed.push({ dir: input.dir, branch: input.branch })
  }

  async diffStat(): Promise<string> {
    return '1 file changed (fake git)'
  }
}
