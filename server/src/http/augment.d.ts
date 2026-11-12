import type { AuthUser } from '../services/auth.js'

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null
    rawBody: Buffer | null
  }
}
