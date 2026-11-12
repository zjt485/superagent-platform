import { hasFeishu, hasWecom, type Config } from '../config.js'
import type { Logger } from '../logger.js'
import type { ChannelProvider } from '../domain/status.js'
import type { ImAdapter, ImRegistry } from '../domain/im.js'
import type { OAuthRegistry } from '../domain/oauth.js'
import type { OutboxSender } from '../services/outbox.js'
import { FeishuAdapter } from './feishu.js'
import { WecomAdapter } from './wecom.js'

export interface ImRuntime {
  adapters: ImRegistry
  oauth: OAuthRegistry
  senders: Map<ChannelProvider, OutboxSender>
}

/**
 * Builds adapters for platforms that have credentials or callback config.
 * Missing credentials mean "simulate delivery" rather than a startup failure,
 * which keeps local demos and tests independent from external services.
 */
export function createIm(config: Config, log: Logger, fetchImpl: typeof fetch = globalThis.fetch): ImRuntime {
  const adapters: ImRegistry = {}
  const oauth: OAuthRegistry = {}
  const senders = new Map<ChannelProvider, OutboxSender>()

  const feishuConfigured = Boolean(config.FEISHU_APP_ID || config.FEISHU_VERIFICATION_TOKEN || config.FEISHU_ENCRYPT_KEY)
  if (feishuConfigured) {
    const adapter = new FeishuAdapter({
      ...(config.FEISHU_APP_ID ? { appId: config.FEISHU_APP_ID } : {}),
      ...(config.FEISHU_APP_SECRET ? { appSecret: config.FEISHU_APP_SECRET } : {}),
      ...(config.FEISHU_VERIFICATION_TOKEN ? { verificationToken: config.FEISHU_VERIFICATION_TOKEN } : {}),
      ...(config.FEISHU_ENCRYPT_KEY ? { encryptKey: config.FEISHU_ENCRYPT_KEY } : {}),
      ...(config.FEISHU_BOT_OPEN_ID ? { botOpenId: config.FEISHU_BOT_OPEN_ID } : {}),
      apiBase: config.FEISHU_API_BASE,
      fetchImpl,
    })
    adapters.feishu = adapter
    if (hasFeishu(config)) {
      oauth.feishu = adapter
      senders.set('feishu', { provider: 'feishu', send: (input) => adapter.send(input) })
    }
    log.info({ configured: hasFeishu(config) }, 'Feishu adapter ready')
  }

  const wecomConfigured = Boolean(config.WECOM_CORP_ID || config.WECOM_TOKEN)
  if (wecomConfigured) {
    const adapter = new WecomAdapter({
      ...(config.WECOM_CORP_ID ? { corpId: config.WECOM_CORP_ID } : {}),
      ...(config.WECOM_AGENT_ID ? { agentId: config.WECOM_AGENT_ID } : {}),
      ...(config.WECOM_SECRET ? { secret: config.WECOM_SECRET } : {}),
      ...(config.WECOM_TOKEN ? { token: config.WECOM_TOKEN } : {}),
      ...(config.WECOM_ENCODING_AES_KEY ? { encodingAesKey: config.WECOM_ENCODING_AES_KEY } : {}),
      apiBase: config.WECOM_API_BASE,
      botName: config.WECOM_BOT_NAME,
      fetchImpl,
    })
    adapters.wecom = adapter
    if (hasWecom(config)) {
      oauth.wecom = adapter
      senders.set('wecom', { provider: 'wecom', send: (input) => adapter.send(input) })
    }
    log.info({ configured: hasWecom(config) }, 'WeCom adapter ready')
  }

  return { adapters, oauth, senders }
}

export type { ImAdapter }
