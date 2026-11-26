import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

import { api, cookieOf, createHarness, type Harness } from '../helpers/app.js'
import { actionApprovals, bots, sessionTurns, tickets } from '../../src/db/schema.js'
import { OpenAiTurnRuntime } from '../../src/core/agent/openai.js'
import { RuntimeExecutor } from '../../src/core/worker/runtime-executor.js'
import { dispatchOnce } from '../../src/core/worker/dispatcher.js'
import { coreTick } from '../../src/core/worker/tick.js'
import { RuleBasedRouterModel } from '../../src/core/router/model.js'
import { createDbWorkspaceProvider } from '../../src/core/worker/workspace-provider.js'
import { loginWithIdentity } from '../../src/services/auth.js'
import { addMemberByUserId } from '../../src/services/projects.js'
import { buildFeishuInteractiveCard } from '../../src/im/feishu.js'

const harnesses: Harness[] = []
const dirs: string[] = []

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

function completion(content: string | null, toolCalls?: unknown[]) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('Phase 2: Tool-level Action Approval, Checkpoint Resume & Feishu Interactive Cards', () => {
  it('pauses on a confirm-gated tool call, saves checkpoint, and resumes seamlessly after Web approval', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'phase2-approval-'))
    dirs.push(dir)
    const h = await createHarness({ WORKSPACES_DIR: dir })
    harnesses.push(h)

    const login = await api(h, 'POST', '/v1/auth/dev-login', { body: { name: 'Alice' } })
    const cookie = cookieOf(login)
    const projectRes = await api(h, 'POST', '/v1/projects', { cookie, body: { name: '审批测试项目' } })
    const projectId = projectRes.json.project.id as string

    // Create a bot whose `run_command` tool requires human confirmation.
    const botRes = await api(h, 'POST', `/v1/projects/${projectId}/bots`, {
      cookie,
      body: {
        slug: 'ops',
        name: '运维助手',
        roleTitle: '受控命令执行',
        toolPolicy: { allowedTools: ['read_file', 'write_file', 'run_command'], rules: { run_command: 'confirm' } },
      },
    })
    expect(botRes.status).toBe(201)

    const roomsRes = await api(h, 'GET', `/v1/projects/${projectId}/rooms`, { cookie })
    const roomId = roomsRes.json.items[0].id as string
    await api(h, 'POST', `/v1/projects/${projectId}/rooms/${roomId}/messages`, {
      cookie,
      body: { content: '@ops 请运行一次诊断命令' },
    })

    await coreTick({ db: h.ctx.db, model: new RuleBasedRouterModel(), now: h.ctx.now })

    const responses = [
      // Turn 1: model tries to call `run_command` -> intercepted by gate (`confirm`)
      completion(null, [
        {
          id: 'call_cmd_1',
          type: 'function',
          function: { name: 'run_command', arguments: JSON.stringify({ command: 'echo hello-approved' }) },
        },
      ]),
      // Resume turn: after human approves, tool runs and model returns final ready report
      completion(JSON.stringify({ status: 'ready', summary: '命令已获批执行完毕：hello-approved' })),
    ]
    const seenToolResults: string[] = []
    const runtime = new OpenAiTurnRuntime({
      baseUrl: 'https://llm.test/v1',
      apiKey: 'secret',
      model: 'deepseek-chat',
      temperature: 0,
      maxOutputTokens: 1000,
      maxSteps: 5,
      inputCostPer1M: 0,
      outputCostPer1M: 0,
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> }
        for (const msg of body.messages ?? []) {
          if (msg.role === 'tool') seenToolResults.push(msg.content)
        }
        const next = responses.shift()
        if (!next) throw new Error('unexpected LLM call')
        return next
      }) as typeof fetch,
    })

    const workspace = createDbWorkspaceProvider({
      db: h.ctx.db,
      rootDir: dir,
      github: h.ctx.github,
      webBase: h.config.GITHUB_WEB_BASE,
    })
    const executor = new RuntimeExecutor(runtime)

    // Turn 1 pauses cleanly for approval!
    expect(await dispatchOnce({ db: h.ctx.db, executor, workspace, now: h.ctx.now })).toBe(true)

    const [ticketAfterPause] = await h.ctx.db.select().from(tickets).where(eq(tickets.projectId, projectId))
    expect(ticketAfterPause?.stage).toBe('waiting_approval')

    const [pausedTurn] = await h.ctx.db.select().from(sessionTurns).where(eq(sessionTurns.ticketId, ticketAfterPause!.id))
    expect(pausedTurn?.status).toBe('waiting_approval')
    expect(pausedTurn?.checkpoint).toBeTruthy()

    // Web Inbox lists the pending approval.
    const inbox = await api(h, 'GET', `/v1/projects/${projectId}/approvals?status=pending`, { cookie })
    expect(inbox.status).toBe(200)
    expect(inbox.json.items).toHaveLength(1)
    const approvalId = inbox.json.items[0].id as string
    expect(inbox.json.items[0].toolName).toBe('run_command')

    // Approve via API -> queues `resume` turn!
    const decided = await api(h, 'POST', `/v1/projects/${projectId}/approvals/${approvalId}/decide`, {
      cookie,
      body: { decision: 'approved', comment: '可以执行' },
    })
    expect(decided.status).toBe(200)
    expect(decided.json.resumeTurnId).toBeTruthy()

    // Dispatch resume turn -> executes saved `echo hello-approved` and finishes!
    expect(await dispatchOnce({ db: h.ctx.db, executor, workspace, now: h.ctx.now })).toBe(true)
    expect(seenToolResults.some((content) => content.includes('hello-approved'))).toBe(true)

    const [ticketFinal] = await h.ctx.db.select().from(tickets).where(eq(tickets.id, ticketAfterPause!.id))
    expect(ticketFinal?.stage).toBe('answer')
    const [approvalRow] = await h.ctx.db.select().from(actionApprovals).where(eq(actionApprovals.id, approvalId))
    expect(approvalRow?.status).toBe('approved')
  })

  it('builds Feishu interactive approval cards and processes /webhooks/feishu/card clicks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'phase2-feishu-card-'))
    dirs.push(dir)
    const h = await createHarness({ WORKSPACES_DIR: dir })
    harnesses.push(h)

    const feishuOwner = await loginWithIdentity(h.ctx, 'feishu', { externalId: 'ou_approver', name: '飞书审批人' })
    const login = await api(h, 'POST', '/v1/auth/dev-login', { body: { name: 'Alice' } })
    const cookie = cookieOf(login)
    const projectRes = await api(h, 'POST', '/v1/projects', { cookie, body: { name: '飞书卡片项目' } })
    const projectId = projectRes.json.project.id as string
    await addMemberByUserId(h.ctx, projectId, { id: login.json.user.id, name: 'Alice', isAdmin: false }, { userId: feishuOwner.id, role: 'maintainer' })

    // Create a ticket + paused turn + pending approval.
    const roomsRes = await api(h, 'GET', `/v1/projects/${projectId}/rooms`, { cookie })
    const roomId = roomsRes.json.items[0].id as string
    await api(h, 'POST', `/v1/projects/${projectId}/bots`, {
      cookie,
      body: { slug: 'ops', name: '运维', roleTitle: 'Ops', toolPolicy: { rules: { run_command: 'confirm' } } },
    })
    await api(h, 'POST', `/v1/projects/${projectId}/rooms/${roomId}/messages`, {
      cookie,
      body: { content: '@ops 跑命令' },
    })
    await coreTick({ db: h.ctx.db, model: new RuleBasedRouterModel(), now: h.ctx.now })

    const runtime = new OpenAiTurnRuntime({
      baseUrl: 'https://llm.test/v1',
      apiKey: 'secret',
      model: 'deepseek-chat',
      temperature: 0,
      maxOutputTokens: 1000,
      maxSteps: 3,
      inputCostPer1M: 0,
      outputCostPer1M: 0,
      fetchImpl: (async () =>
        completion(null, [
          { id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'echo ok' }) } },
        ])) as typeof fetch,
    })
    await dispatchOnce({
      db: h.ctx.db,
      executor: new RuntimeExecutor(runtime),
      workspace: createDbWorkspaceProvider({ db: h.ctx.db, rootDir: dir, github: h.ctx.github, webBase: h.config.GITHUB_WEB_BASE }),
      now: h.ctx.now,
    })
    const [pending] = await h.ctx.db.select().from(actionApprovals).where(eq(actionApprovals.projectId, projectId))
    expect(pending?.status).toBe('pending')

    // Verify Feishu interactive card structure.
    const card = buildFeishuInteractiveCard({
      title: pending!.title,
      body: '预览',
      approvalId: pending!.id,
      projectId,
      riskLevel: 'high',
      status: 'pending',
    })
    expect((card.header as { template: string }).template).toBe('orange')

    // Click "拒绝" on Feishu card callback webhook.
    const callback = await api(h, 'POST', '/webhooks/feishu/card', {
      csrf: false,
      body: {
        token: h.config.FEISHU_VERIFICATION_TOKEN,
        open_id: 'ou_approver',
        action: { value: { action: 'approval', decision: 'rejected', projectId, approvalId: pending!.id } },
      },
    })
    expect(callback.status).toBe(200)
    expect(callback.json.header.template).toBe('red')
    const [updated] = await h.ctx.db.select().from(actionApprovals).where(eq(actionApprovals.id, pending!.id))
    expect(updated?.status).toBe('rejected')
    expect((await h.ctx.db.select().from(bots).where(eq(bots.projectId, projectId))).length).toBe(1)
  })
})
