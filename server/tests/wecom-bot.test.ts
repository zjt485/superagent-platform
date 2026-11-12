import { describe, expect, it } from 'vitest'
import type { WsFrame } from '@wecom/aibot-node-sdk'
import { botEventFromFrame } from '../src/im/wecom-bot.js'

function frame(body: Record<string, unknown>): WsFrame {
  return { headers: { req_id: 'req_1' }, body } as WsFrame
}

describe('WeCom smart robot frames', () => {
  it('normalizes a group @ text into an InboundEvent', () => {
    const event = botEventFromFrame(
      frame({
        msgid: 'msg_1',
        chatid: 'wc_managed_1',
        chattype: 'group',
        from: { userid: 'wx_alice' },
        msgtype: 'text',
        text: { content: '@Superagent 修复登录页' },
      }),
      'Superagent',
    )
    expect(event?.deliveryId).toBe('msg_1')
    expect(event?.messages[0]).toMatchObject({
      provider: 'wecom',
      externalChatId: 'wc_managed_1',
      text: '修复登录页',
      mentionBot: true,
      sender: { externalId: 'wx_alice' },
    })
  })

  it('keeps slash commands intact', () => {
    const event = botEventFromFrame(
      frame({
        msgid: 'msg_2',
        chatid: 'wc_managed_1',
        chattype: 'group',
        from: { userid: 'wx_alice' },
        msgtype: 'text',
        text: { content: '@Superagent /status' },
      }),
      'Superagent',
    )
    expect(event?.messages[0]?.text).toBe('/status')
  })

  it('joins mixed text items and prefixes direct messages', () => {
    const event = botEventFromFrame(
      frame({
        msgid: 'msg_3',
        chattype: 'single',
        from: { userid: 'wx_bob' },
        msgtype: 'mixed',
        mixed: {
          msg_item: [
            { msgtype: 'text', text: { content: '第一行' } },
            { msgtype: 'image', image: { url: 'https://example.test/a.png' } },
            { msgtype: 'text', text: { content: '第二行' } },
          ],
        },
      }),
      'Superagent',
    )
    expect(event?.messages[0]?.externalChatId).toBe('p2p:wx_bob')
    expect(event?.messages[0]?.text).toBe('第一行 第二行')
  })

  it('drops empty or malformed frames', () => {
    expect(botEventFromFrame(frame({ chattype: 'group' }), 'Superagent')).toBeNull()
    expect(
      botEventFromFrame(
        frame({ msgid: 'msg_4', chattype: 'group', from: { userid: 'wx' }, msgtype: 'text', text: { content: '' } }),
        'Superagent',
      ),
    ).toBeNull()
  })
})
