import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyGithubSignature } from '../src/github/verify.js'
import { MockGithubClient } from '../src/github/client.js'
import { testConfig } from './helpers/app.js'

describe('GitHub webhook signature', () => {
  const secret = 'webhook-secret'
  const body = JSON.stringify({ action: 'opened' })

  it('accepts a valid sha256 signature', () => {
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    expect(verifyGithubSignature(secret, body, signature)).toBe(true)
  })

  it('rejects tampering and malformed headers', () => {
    expect(verifyGithubSignature(secret, `${body} `, `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)).toBe(false)
    expect(verifyGithubSignature(secret, body, 'sha1=abc')).toBe(false)
    expect(verifyGithubSignature(secret, body, undefined)).toBe(false)
  })
})

describe('mock GitHub adapter', () => {
  it('returns deterministic repositories and PR URLs', async () => {
    const client = new MockGithubClient(testConfig())
    const repos = await client.installationRepos('1')
    expect(repos[0]?.fullName).toBe('demo-org/hello-world')
    const pr = await client.createPullRequest({
      installationId: '1',
      owner: 'demo-org',
      name: 'hello-world',
      head: 'agent/x',
      base: 'main',
      title: 't',
      body: 'b',
    })
    expect(pr.url).toContain('https://github.com/demo-org/hello-world/pull/')
  })
})
