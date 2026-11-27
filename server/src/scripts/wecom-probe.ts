/**
 * WeCom live connectivity probe.
 * Reads `.env`, reports outbound public IP, checks required WeCom variables,
 * tests self-built app `gettoken`, and tests 智能机器人 WebSocket auth.
 * Never prints any secret values.
 */

import AiBot from '@wecom/aibot-node-sdk'
import { hasWecom, hasWecomBot, loadConfig } from '../config.js'
import { loadLocalEnv } from '../env.js'

loadLocalEnv()
const config = loadConfig()

function ok(label: string, detail?: string): void {
  process.stdout.write(`[OK]   ${label}${detail ? ` — ${detail}` : ''}\n`)
}
function warn(label: string, detail?: string): void {
  process.stdout.write(`[WARN] ${label}${detail ? ` — ${detail}` : ''}\n`)
}
function fail(label: string, detail?: string): void {
  process.stdout.write(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}\n`)
}

async function fetchPublicIp(): Promise<string | null> {
  const endpoints = ['https://api.ipify.org?format=text', 'https://ifconfig.me/ip', 'https://icanhazip.com']
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        const ip = (await res.text()).trim()
        if (ip && ip.length < 64) return ip
      }
    } catch {
      // try next
    }
  }
  return null
}

process.stdout.write('\n=== Superagent 企业微信连通性探针 ===\n\n')

const publicIp = await fetchPublicIp()
if (publicIp) ok('本机公网出口 IP（填入企微自建应用「企业可信 IP」）', publicIp)
else warn('本机公网出口 IP', '未能自动获取，请通过浏览器查询当前出口 IP')

ok('PUBLIC_BASE_URL', config.PUBLIC_BASE_URL)
ok('AGENT_RUNTIME / GITHUB_MODE', `${config.AGENT_RUNTIME} / ${config.GITHUB_MODE}`)

// 1. Check self-built app credentials & gettoken
if (!hasWecom(config)) {
  warn('企业微信自建应用 (阶段 B)', '尚未填写 WECOM_CORP_ID 或 WECOM_SECRET')
} else {
  ok('自建应用基础配置', `CORP_ID=${config.WECOM_CORP_ID} AGENT_ID=${config.WECOM_AGENT_ID ?? '(未填)'}`)
  if (!config.WECOM_TOKEN || !config.WECOM_ENCODING_AES_KEY) {
    warn('自建应用回调加解密', 'WECOM_TOKEN 或 WECOM_ENCODING_AES_KEY 未填（如仅用 OAuth + appchat 可忽略）')
  } else if (config.WECOM_ENCODING_AES_KEY.length !== 43) {
    fail('WECOM_ENCODING_AES_KEY 长度错误', `应为 43 位，当前 ${config.WECOM_ENCODING_AES_KEY.length} 位`)
  } else {
    ok('自建应用回调加解密', 'TOKEN 与 43 位 EncodingAESKey 格式正常')
  }

  try {
    const query = new URLSearchParams({
      corpid: config.WECOM_CORP_ID!,
      corpsecret: config.WECOM_SECRET!,
    })
    const res = await fetch(`${config.WECOM_API_BASE}/cgi-bin/gettoken?${query.toString()}`, {
      signal: AbortSignal.timeout(8000),
    })
    const payload = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number }
    if (res.ok && payload.access_token) {
      ok('自建应用 gettoken 鉴权', `成功获取 access_token（有效期 ${payload.expires_in ?? 7200}s）`)
    } else {
      const hint =
        payload.errcode === 60020
          ? `请将出口 IP ${publicIp ?? ''} 添加到企微自建应用「企业可信 IP」`
          : payload.errmsg ?? `HTTP ${res.status}`
      fail('自建应用 gettoken 鉴权失败', `errcode=${payload.errcode ?? res.status}: ${hint}`)
    }
  } catch (error) {
    fail('自建应用 gettoken 请求异常', error instanceof Error ? error.message : String(error))
  }
}

// 2. Check WeCom smart robot WebSocket long connection
if (!hasWecomBot(config)) {
  warn('企业微信智能机器人长连接 (阶段 A)', '尚未填写 WECOM_BOT_ID 或 WECOM_BOT_SECRET')
} else {
  ok('智能机器人配置', `WECOM_BOT_ID=${config.WECOM_BOT_ID} WECOM_BOT_NAME=${config.WECOM_BOT_NAME}`)
  await new Promise<void>((resolve) => {
    let settled = false
    const client = new AiBot.WSClient({
      botId: config.WECOM_BOT_ID!,
      secret: config.WECOM_BOT_SECRET!,
      ...(config.WECOM_BOT_WS_URL ? { wsUrl: config.WECOM_BOT_WS_URL } : {}),
      maxReconnectAttempts: 0,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    })
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        client.disconnect()
      } catch {
        // ignore
      }
      resolve()
    }
    const timer = setTimeout(() => {
      fail('智能机器人长连接鉴权超时', '10 秒内未收到 authenticated 事件，请检查 BotID/Secret 及机器人是否已切换为「长连接」模式')
      done()
    }, 10_000)

    client.on('authenticated', () => {
      ok('智能机器人 WebSocket 长连接鉴权', 'authenticated 成功！可正常接收与回复群 @ 消息')
      done()
    })
    client.on('error', (error) => {
      fail('智能机器人长连接错误', error instanceof Error ? error.message : String(error))
      done()
    })
    client.connect()
  })
}

process.stdout.write('\n=== 探测结束 ===\n')
process.exit(0)
