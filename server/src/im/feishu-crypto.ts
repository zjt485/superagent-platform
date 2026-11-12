import { createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Feishu (Lark) callback cryptography:
 * - signature: sha256(timestamp + nonce + encryptKey + rawBody), hex
 * - encrypted payload: AES-256-CBC, key = sha256(encryptKey), IV = first 16 bytes
 */
export function feishuSignature(input: { timestamp: string; nonce: string; encryptKey: string; rawBody: string }): string {
  return createHash('sha256').update(`${input.timestamp}${input.nonce}${input.encryptKey}${input.rawBody}`, 'utf8').digest('hex')
}

export function verifyFeishuSignature(input: {
  timestamp: string
  nonce: string
  encryptKey: string
  rawBody: string
  signature: string
}): boolean {
  const expected = feishuSignature(input)
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(input.signature.toLowerCase(), 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

export function decryptFeishuPayload(encryptKey: string, encrypted: string): string {
  const key = createHash('sha256').update(encryptKey, 'utf8').digest()
  const buffer = Buffer.from(encrypted, 'base64')
  if (buffer.length <= 16) throw new Error('encrypted payload is too short')
  const decipher = createDecipheriv('aes-256-cbc', key, buffer.subarray(0, 16))
  return Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()]).toString('utf8')
}

export function encryptFeishuPayload(encryptKey: string, plain: string): string {
  const key = createHash('sha256').update(encryptKey, 'utf8').digest()
  const iv = Buffer.from('0123456789abcdef', 'utf8')
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, body]).toString('base64')
}

/** Feishu signs `sha1(sorted(token, timestamp, nonce, encrypt))` for WeCom? Kept named to avoid confusion. */
export function hmacHex(secret: string, body: string, algorithm: 'sha256' | 'sha1' = 'sha256'): string {
  return createHmac(algorithm, secret).update(body, 'utf8').digest('hex')
}
