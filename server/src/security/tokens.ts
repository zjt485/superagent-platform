import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Compact signed value: base64url(JSON payload).base64url(HMAC-SHA256). */
export function signValue(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${signature}`
}

export function verifyValue<T extends Record<string, unknown>>(secret: string, token: string): T | null {
  const index = token.lastIndexOf('.')
  if (index <= 0) return null
  const body = token.slice(0, index)
  const signature = token.slice(index + 1)
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  if (!constantTimeEqual(signature, expected)) return null
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url')
