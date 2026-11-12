import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface GitCloneInput {
  url: string
  dir: string
  branch: string
  env: Record<string, string>
}

export interface GitCommitInput {
  dir: string
  branch: string
  message: string
  author: { name: string; email: string }
  env: Record<string, string>
}

/** The git operations a run needs; tests and demos substitute a fake. */
export interface GitOps {
  clone(input: GitCloneInput): Promise<void>
  createBranchAndCommit(input: GitCommitInput): Promise<boolean>
  push(input: { dir: string; branch: string; env: Record<string, string> }): Promise<void>
  diffStat(dir: string): Promise<string>
}

/**
 * GitHub App auth for git over HTTPS without writing tokens to disk or argv:
 * the token travels in GIT_CONFIG_* environment variables.
 */
export function gitAuthEnv(token: string, webBase = 'https://github.com'): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${webBase}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  }
}

export class RealGitOps implements GitOps {
  async clone(input: GitCloneInput): Promise<void> {
    await this.exec(['clone', '--depth', '1', '--branch', input.branch, input.url, input.dir], { env: input.env })
  }

  async createBranchAndCommit(input: GitCommitInput): Promise<boolean> {
    // Reuse the ticket branch on follow-up turns; create it on the first turn.
    try {
      await this.exec(['checkout', input.branch], { cwd: input.dir, env: input.env })
    } catch {
      await this.exec(['checkout', '-b', input.branch], { cwd: input.dir, env: input.env })
    }
    await this.exec(['add', '-A'], { cwd: input.dir, env: input.env })
    const status = await this.exec(['status', '--porcelain'], { cwd: input.dir, env: input.env })
    if (!status.stdout.trim()) return false
    await this.exec(
      [
        '-c',
        `user.name=${input.author.name}`,
        '-c',
        `user.email=${input.author.email}`,
        'commit',
        '-m',
        input.message,
      ],
      { cwd: input.dir, env: input.env },
    )
    return true
  }

  async push(input: { dir: string; branch: string; env: Record<string, string> }): Promise<void> {
    await this.exec(['push', 'origin', `HEAD:refs/heads/${input.branch}`], { cwd: input.dir, env: input.env })
  }

  async diffStat(dir: string): Promise<string> {
    const result = await this.exec(['show', '--stat', '--oneline', '-1'], { cwd: dir, env: {} })
    return result.stdout.slice(0, 4000)
  }

  private async exec(args: string[], options: { cwd?: string; env: Record<string, string> }): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await run('git', args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      })
      return { stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`git ${args[0] ?? ''} failed: ${redact(message)}`)
    }
  }
}

function redact(value: string): string {
  return value
    .replace(/AUTHORIZATION: basic [A-Za-z0-9+/=]+/g, 'AUTHORIZATION: basic [redacted]')
    .replace(/x-access-token:[^@\s]+/g, 'x-access-token:[redacted]')
    .slice(0, 2000)
}
