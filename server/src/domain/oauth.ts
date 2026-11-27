import type { ChannelProvider } from './status.js'

export interface OAuthIdentity {
  externalId: string
  name: string
  avatar?: string
  email?: string
}

export interface OAuthProvider {
  provider: ChannelProvider
  authorizeUrl(input: { state: string; redirectUri: string; userAgent?: string | null }): string
  exchange(input: { code: string; redirectUri: string }): Promise<OAuthIdentity>
}

export type OAuthRegistry = Partial<Record<ChannelProvider, OAuthProvider>>
