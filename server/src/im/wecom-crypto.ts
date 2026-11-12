import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { constantTimeEqual } from '../security/tokens.js'

/**
 * WeCom (企业微信) callback cryptography:
 * - signature = sha1(sort([token, timestamp, nonce, encrypt]).join(''))
 * - AES-256-CBC with key = base64(EncodingAESKey + '=') and IV = key[0..16]
 * - plaintext = random(16) + uint32be(msgLen) + msg + corpId, padded to 32 bytes
 */
export function wecomSignature(input: { token: string; timestamp: string; nonce: string; encrypt: string }): string {
  return createHash('sha1')
    .update([input.token, input.timestamp, input.nonce, input.encrypt].sort().join(''), 'utf8')
    .digest('hex')
}

export function verifyWecomSignature(input: {
  token: string
  timestamp: string
  nonce: string
  encrypt: string
  signature: string
}): boolean {
  return constantTimeEqual(wecomSignature(input), input.signature.toLowerCase())
}

function aesKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey}=`, 'base64')
  if (key.length !== 32) throw new Error('EncodingAESKey must decode to 32 bytes')
  return key
}

export function decryptWecom(encodingAesKey: string, encrypted: string): { message: string; corpId: string } {
  const key = aesKey(encodingAesKey)
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()])
  const pad = plain[plain.length - 1] ?? 0
  if (pad < 1 || pad > 32 || pad > plain.length) throw new Error('invalid WeCom padding')
  const content = plain.subarray(0, plain.length - pad)
  if (content.length < 20) throw new Error('WeCom payload is too short')
  const messageLength = content.readUInt32BE(16)
  const message = content.subarray(20, 20 + messageLength).toString('utf8')
  const corpId = content.subarray(20 + messageLength).toString('utf8')
  return { message, corpId }
}

export function encryptWecom(
  encodingAesKey: string,
  message: string,
  corpId: string,
  random: Buffer = Buffer.alloc(16, 7),
): string {
  const key = aesKey(encodingAesKey)
  const messageBuffer = Buffer.from(message, 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(messageBuffer.length, 0)
  const body = Buffer.concat([random, length, messageBuffer, Buffer.from(corpId, 'utf8')])
  const blockSize = 32
  const pad = blockSize - (body.length % blockSize) || blockSize
  const padded = Buffer.concat([body, Buffer.alloc(pad, pad)])
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
}
