import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './helpers/app.js'
import { loginWithIdentity } from '../src/services/auth.js'
import { bindChannel, bindRepo, createProject, updateProject } from '../src/services/projects.js'
import { acceptInvite, createInvite, previewInvite } from '../src/services/invites.js'
import { joinProjectGroup, projectGroupInfo } from '../src/services/group-join.js'
import type { ImAdapter } from '../src/domain/im.js'

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close()
})

async function harness(): Promise<Harness> {
  const instance = await createHarness()
  harnesses.push(instance)
  return instance
}

async function seed(h: Harness) {
  const alice = await loginWithIdentity(h.ctx, 'feishu', { externalId: 'ou_alice', name: 'Alice' })
  const bob = await loginWithIdentity(h.ctx, 'feishu', { externalId: 'ou_bob', name: 'Bob' })
  const project = await createProject(h.ctx, alice, { name: '扫码项目' })
  await bindRepo(h.ctx, project.id, alice, { installationId: '1', owner: 'demo-org', name: 'hello-world' })
  await bindChannel(h.ctx, project.id, alice, {
    provider: 'feishu',
    externalChatId: 'oc_group',
    name: '项目群',
    config: {
      joinUrl: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_group',
      qrDataUrl: 'data:image/png;base64,AAAA',
      autoJoin: true,
      webhookUrl: 'https://evil.example.com/should-be-dropped',
    },
  })
  await updateProject(h.ctx, project.id, alice, { status: 'active' })
  const { token } = await createInvite(h.ctx, project.id, alice, { role: 'member', maxUses: 5 })
  return { alice, bob, project, token }
}

function fakeFeishu(addMembers: ImAdapter['addMembers']): ImAdapter {
  return {
    provider: 'feishu',
    async verifyAndParse() {
      return { events: [], deliveryIds: [] }
    },
    async send() {
      return { messageId: 'om_test' }
    },
    ...(addMembers ? { addMembers } : {}),
  }
}

describe('scan to join the project group', () => {
  it('returns the group QR and invite link with an invite preview and acceptance', async () => {
    const h = await harness()
    const { bob, project, token } = await seed(h)

    const preview = await previewInvite(h.ctx, token)
    expect(preview.group).toMatchObject({ provider: 'feishu', chatId: 'oc_group', autoJoin: true })
    expect(preview.group?.qrDataUrl).toBe('data:image/png;base64,AAAA')

    const group = await projectGroupInfo(h.ctx, project.id)
    expect(group?.joinUrl).toContain('applink.feishu.cn')
    // Unknown channel config keys are not persisted.
    const [channel] = await h.ctx.db.select().from((await import('../src/db/schema.js')).channels)
    expect(channel?.config).not.toHaveProperty('webhookUrl')

    await acceptInvite(h.ctx, token, bob)
    const outcome = await joinProjectGroup(h.ctx, project.id, bob)
    expect(outcome.group?.qrDataUrl).toBe('data:image/png;base64,AAAA')
    expect(outcome.joined).toBe(false)
  })

  it('automatically adds a Feishu member with a matching identity', async () => {
    const h = await harness()
    const { bob, project, token } = await seed(h)
    const calls: { chatId: string; externalUserIds: string[] }[] = []
    h.ctx.im = {
      feishu: fakeFeishu(async (input) => {
        calls.push(input)
        return { added: input.externalUserIds }
      }),
    }

    await acceptInvite(h.ctx, token, bob)
    const outcome = await joinProjectGroup(h.ctx, project.id, bob)
    expect(outcome.joined).toBe(true)
    expect(calls).toEqual([{ chatId: 'oc_group', externalUserIds: ['ou_bob'] }])
  })

  it('falls back to the QR/link when the platform call fails', async () => {
    const h = await harness()
    const { bob, project, token } = await seed(h)
    h.ctx.im = {
      feishu: fakeFeishu(async () => {
        throw new Error('bot is not a group admin')
      }),
    }

    await acceptInvite(h.ctx, token, bob)
    const outcome = await joinProjectGroup(h.ctx, project.id, bob)
    expect(outcome.joined).toBe(false)
    expect(outcome.error).toContain('group admin')
    expect(outcome.group?.qrDataUrl).toBeTruthy()
  })
})
