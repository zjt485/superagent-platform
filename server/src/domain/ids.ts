import { randomBytes, randomUUID } from 'node:crypto'

export const newId = (): string => randomUUID()

export const newToken = (bytes = 32): string => randomBytes(bytes).toString('base64url')

export const shortId = (id: string): string => id.replace(/-/g, '').slice(0, 8)

export const slugify = (value: string): string => {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || `project-${shortId(newId())}`
}
