import { createHmac, timingSafeEqual } from 'node:crypto'

/** GitHub App webhook signature: `X-Hub-Signature-256: sha256=<hex hmac>`. */
export function verifyGithubSignature(secret: string, rawBody: Buffer | string, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const actual = header.slice('sha256='.length).toLowerCase()
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(actual, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}
