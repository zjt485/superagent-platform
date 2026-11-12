import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { api, createHarness, type Harness } from './helpers/app.js'
import { createSession, loginWithIdentity } from '../src/services/auth.js'
import { bindChannel, bindRepo, createProject, updateProject } from '../src/services/projects.js'
import { createManagedWecomGroup, acceptJoinLink, previewJoinLink, getJoinLink } from '../src/services/wecom-join.js'
import { channels, projectMembers, projects } from '../src/db/schema.js'
import type { ImAdapter } from '../src/domain/im.js'

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close()
})

async function harness(): Promise<Harness> {
  const h = await createHarness()
  harnesses.push(h)
  return h
}

function fakeWecom() {
  const created: { name: string; ownerUserId: string; userIds: string[] }[] = []
  const added: { chatId: string; externalUserIds: string[] }[] = []
  const adapter: ImAdapter = {
    provider: 'wecom',
    async verifyAndParse() {
      return { events: [], deliveryIds: [] }
    },
    async send() {
      return { messageId: 'wc_out' }
    },
    async createChat(input) {
      created.push(input)
      return { chatId: 'wc_managed_1' }
    },
    async addMembers(input) {
      added.push(input)
      return { added: input.externalUserIds }
    },
  }
  return { adapter, created, added }
}

async function seed() {
  const h = await harness()
  const alice = await loginWithIdentity(h.ctx, 'wecom', { externalId: 'wx_alice', name: 'Alice' })
  const bob = await loginWithIdentity(h.ctx, 'wecom', { externalId: 'wx_bob', name: 'Bob' })
  const project = await createProject(h.ctx, alice, { name: '企微扫码项目' })
  await bindRepo(h.ctx, project.id, alice, { installationId: '1', owner: 'demo-org', name: 'hello-world' })
  const fake = fakeWecom()
  h.ctx.im = { wecom: fake.adapter }
  return { h, alice, bob, project, fake }
}

describe('WeCom real scan-to-join', () => {
  it('creates an app-managed group, activates the project and returns a QR join link', async () => {
    const { h, alice, project, fake } = await seed()
    const setup = await createManagedWecomGroup(h.ctx, project.id, alice)
    expect(fake.created[0]).toMatchObject({ ownerUserId: 'wx_alice' })
    expect(fake.created[0]?.userIds).toContain('wx_alice')
    expect(setup.channel.provider).toBe('wecom')
    expect(setup.channel.config).toMatchObject({ managed: true, autoJoin: true })
    expect(setup.join.url).toContain('/join/')
    expect(setup.join.qrDataUrl).toMatch(/^data:image\/png;base64,/)
    const [updated] = await h.ctx.db.select().from(projects).where(eq(projects.id, project.id))
    expect(updated?.status).toBe('active')
    const [channel] = await h.ctx.db.select().from(channels).where(eq(channels.projectId, project.id))
    expect(channel?.externalChatId).toBe('wc_managed_1')

    const again = await createManagedWecomGroup(h.ctx, project.id, alice)
    expect(again.channel.id).toBe(setup.channel.id)
    expect(fake.created).toHaveLength(1)
  })

  it('adds a scanner to the bound WeCom group and the project on accept', async () => {
    const { h, alice, bob, project, fake } = await seed()
    const setup = await createManagedWecomGroup(h.ctx, project.id, alice)
    const preview = await previewJoinLink(h.ctx, setup.join.token)
    expect(preview.valid).toBe(true)
    expect(preview.project?.name).toBe('企微扫码项目')

    const accepted = await acceptJoinLink(h.ctx, setup.join.token, bob)
    expect(accepted.group.joined).toBe(true)
    expect(fake.added[0]).toEqual({ chatId: 'wc_managed_1', externalUserIds: ['wx_bob'] })
    const member = await h.ctx.db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.userId, bob.id))
    expect(member[0]?.role).toBe('member')
    expect(h.ctx.config.PUBLIC_BASE_URL).toContain('http')

    const link = await getJoinLink(h.ctx, project.id, { id: alice.id, isAdmin: false })
    expect(link.join?.token).toBeTruthy()
    expect(link.reason).toBeUndefined()
  })

  it('requires a bound repo and a WeCom identity before creating the group', async () => {
    const h = await harness()
    const dev = await loginWithIdentity(h.ctx, 'dev', { externalId: 'dev-owner', name: 'Dev' })
    const project = await createProject(h.ctx, dev, { name: '缺仓库' })
    h.ctx.im = { wecom: fakeWecom().adapter }
    await expect(createManagedWecomGroup(h.ctx, project.id, dev)).rejects.toThrow(/GitHub 仓库/)
    await bindRepo(h.ctx, project.id, dev, { installationId: '1', owner: 'demo-org', name: 'hello-world' })
    await expect(createManagedWecomGroup(h.ctx, project.id, dev)).rejects.toThrow(/企业微信登录/)
  })

  it('rejects scans after the token is tampered with', async () => {
    const { h, project, alice } = await seed()
    const setup = await createManagedWecomGroup(h.ctx, project.id, alice)
    const preview = await previewJoinLink(h.ctx, `${setup.join.token}x`)
    expect(preview.valid).toBe(false)
  })

  it('exposes the flow through the HTTP API for the console QR page', async () => {
    const { h, alice, bob, project } = await seed()
    const aliceSession = await createSession(h.ctx, alice.id)
    const aliceCookie = `sa_session=${aliceSession.token}`
    const created = await api(h, 'POST', `/v1/projects/${project.id}/wecom-group`, { cookie: aliceCookie, body: {} })
    expect(created.status).toBe(201)
    expect(created.json.join.qrDataUrl).toMatch(/^data:image\/png;base64,/)
    const token = created.json.join.token as string

    const preview = await api(h, 'GET', `/v1/join/${encodeURIComponent(token)}`)
    expect(preview.status).toBe(200)
    expect(preview.json.valid).toBe(true)

    const bobSession = await createSession(h.ctx, bob.id)
    const accepted = await api(h, 'POST', `/v1/join/${encodeURIComponent(token)}/accept`, {
      cookie: `sa_session=${bobSession.token}`,
      body: {},
    })
    expect(accepted.status).toBe(201)
    expect(accepted.json.group.joined).toBe(true)
    const members = await h.ctx.db.select().from(projectMembers).where(eq(projectMembers.userId, bob.id))
    expect(members[0]?.role).toBe('member')
  })
})
