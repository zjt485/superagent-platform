import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { api, cookieOf, createHarness, type Harness } from '../helpers/app.js'
import { OpenAiTurnRuntime } from '../../src/core/agent/openai.js'
import { McpClient } from '../../src/core/mcp/client.js'
import { BrowserToolRunner } from '../../src/core/sandbox/browser.js'
import { LocalProcessSandboxProvider } from '../../src/core/sandbox/local.js'
import { dispatchOnce } from '../../src/core/worker/dispatcher.js'
import { RuntimeExecutor } from '../../src/core/worker/runtime-executor.js'
import { coreTick } from '../../src/core/worker/tick.js'
import { RuleBasedRouterModel } from '../../src/core/router/model.js'
import { actionApprovals, artifacts, bots, sessionTurns, tickets } from '../../src/db/schema.js'
import { createMcpServer, discoverMcpServerTools } from '../../src/services/connectors.js'

const harnesses: Harness[] = []
const dirs: string[] = []

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function setupEnv() {
  const workDir = await mkdtemp(path.join(tmpdir(), 'sa-phase3-'))
  dirs.push(workDir)
  const h = await createHarness({ WORKSPACES_DIR: workDir })
  harnesses.push(h)

  const login = await api(h, 'POST', '/v1/auth/dev-login', { body: { name: 'Phase3Tester' } })
  const cookie = cookieOf(login)
  const user = login.json.user as { id: string; isAdmin: boolean }
  const projectRes = await api(h, 'POST', '/v1/projects', { cookie, body: { name: 'Phase3 Lab' } })
  const projectId = projectRes.json.project.id as string
  await api(h, 'POST', `/v1/projects/${projectId}/bots/templates/rd`, { cookie, body: {} })
  const roomsRes = await api(h, 'GET', `/v1/projects/${projectId}/rooms`, { cookie })
  const roomId = roomsRes.json.items[0].id as string
  const projectBots = await h.ctx.db.select().from(bots).where(eq(bots.projectId, projectId))
  const qaBot = projectBots.find((b) => b.slug === 'qa')!
  return { workDir, h, cookie, user, projectId, roomId, qaBot }
}

describe('Phase 3: persistent sandbox, browser screenshots, and MCP connectors', () => {
  it('persists per-Bot home directory across commands and streams terminal chunks', async () => {
    const { workDir, qaBot } = await setupEnv()
    const sandbox = new LocalProcessSandboxProvider(workDir)
    const ws = path.join(workDir, 'ws1')
    const chunks: string[] = []

    const writeRes = await sandbox.execStream({
      botId: qaBot.id,
      workspacePath: ws,
      command: `node -e "const fs=require('fs'),p=require('path'); fs.writeFileSync(p.join(process.env.BOT_HOME,'memo.txt'),'persisted-ok'); console.log('chunk-hello')"`,
      timeoutMs: 15_000,
      onChunk: (_stream, chunk) => {
        chunks.push(chunk)
      },
    })
    expect(writeRes.exitCode).toBe(0)
    expect(chunks.join('')).toContain('chunk-hello')

    // Second invocation in a different ticket workspace still reads the same Bot's persistent home!
    const ws2 = path.join(workDir, 'ws2')
    const readRes = await sandbox.execStream({
      botId: qaBot.id,
      workspacePath: ws2,
      command: `node -e "const fs=require('fs'),p=require('path'); console.log(fs.readFileSync(p.join(process.env.BOT_HOME,'memo.txt'),'utf8'))"`,
      timeoutMs: 15_000,
    })
    expect(readRes.exitCode).toBe(0)
    expect(readRes.stdout).toContain('persisted-ok')
  })

  it('opens web pages, captures screenshot artifacts, emits SSE event, and serves authenticated artifact URL', async () => {
    const { workDir, h, cookie, projectId, qaBot } = await setupEnv()
    const events: Array<{ type: string; payload?: unknown }> = []

    const mockFetch: typeof fetch = async () =>
      new Response(
        '<html><head><title>Pricing Benchmark</title></head><body><h1>Pro Plan $29</h1><a href="/docs">API Docs</a></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      )

    const browser = new BrowserToolRunner({
      db: h.ctx.db,
      rootDir: workDir,
      projectId,
      botId: qaBot.id,
      fetchImpl: mockFetch,
      preferPlaywright: false,
      onEvent: (ev) => {
        events.push(ev)
      },
    })

    const opened = await browser.open('https://example.test/pricing')
    expect(opened.title).toBe('Pricing Benchmark')
    expect(opened.excerpt).toContain('Pro Plan $29')

    const extracted = await browser.extract('h1')
    expect(extracted.text).toContain('Pro Plan $29')

    const shot = await browser.screenshot({ title: '定价页截图' })
    expect(shot.screenshotUrl).toBe(`/v1/projects/${projectId}/artifacts/${shot.artifactId}`)
    expect(events.some((e) => e.type === 'browser_screenshot')).toBe(true)

    const [artifactRow] = await h.ctx.db.select().from(artifacts).where(eq(artifacts.id, shot.artifactId))
    expect(artifactRow?.kind).toBe('browser_screenshot')

    const res = await h.app.inject({
      method: 'GET',
      url: shot.screenshotUrl,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('image/svg+xml')
    expect(res.body).toContain('Pricing Benchmark')
  })

  it('discovers MCP tools, auto-allows read MCP calls, and gates mutating MCP calls with checkpoint resume', async () => {
    const { workDir, h, cookie, user, projectId, roomId } = await setupEnv()

    const mcpCalls: Array<{ method: string; tool?: string; args?: unknown }> = []
    const mcpFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        id: number
        method: string
        params?: { name?: string; arguments?: Record<string, unknown> }
      }
      mcpCalls.push({ method: body.method, tool: body.params?.name, args: body.params?.arguments })
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
        })
      }
      if (body.method === 'tools/list') {
        return new Response(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                {
                  name: 'list_issues',
                  description: 'List open issues',
                  inputSchema: { type: 'object', properties: { team: { type: 'string' } } },
                },
                {
                  name: 'create_issue',
                  description: 'Create a new Linear issue',
                  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
                },
              ],
            },
          })}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      if (body.method === 'tools/call') {
        if (body.params?.name === 'list_issues') {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { issues: [{ id: 'LIN-1', title: 'Login timeout' }] } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { created: 'LIN-2', title: body.params?.arguments?.title } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 404 })
    }

    const mcpClient = new McpClient({ fetchImpl: mcpFetch })
    const server = await createMcpServer(h.ctx, projectId, user, {
      name: 'linear',
      transport: 'streamable_http',
      endpointOrCmd: 'https://mcp.linear.test/v1',
      defaultToolPolicy: 'confirm',
    })
    const discovered = await discoverMcpServerTools(h.ctx, projectId, server.id, user, mcpClient)
    expect(discovered.tools.map((t) => t.name)).toEqual(['list_issues', 'create_issue'])

    // Verify REST listing returns the discovered server
    const listRes = await api(h, 'GET', `/v1/projects/${projectId}/mcp-servers`, { cookie })
    expect(listRes.status).toBe(200)
    expect(listRes.json.items[0].cachedTools.length).toBe(2)

    await api(h, 'POST', `/v1/projects/${projectId}/rooms/${roomId}/messages`, {
      cookie,
      body: { content: '@pm 查询 Linear 问题并创建跟进工单' },
    })
    await coreTick({ db: h.ctx.db, model: new RuleBasedRouterModel(), now: h.ctx.now })

    let llmStep = 0
    const llmFetch: typeof fetch = async (_url, init) => {
      llmStep += 1
      const reqBody = JSON.parse(String(init?.body ?? '{}')) as {
        tools?: Array<{ function?: { name?: string } }>
        messages?: Array<{ role: string; content: string | null }>
      }
      if (llmStep === 1) {
        const toolNames = (reqBody.tools ?? []).map((t) => t.function?.name)
        expect(toolNames).toContain('mcp__linear__list_issues')
        expect(toolNames).toContain('mcp__linear__create_issue')
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'mcp__linear__list_issues', arguments: '{"team":"RD"}' } },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (llmStep === 2) {
        const toolMessages = (reqBody.messages ?? []).filter((m) => m.role === 'tool')
        expect(toolMessages[0]?.content).toContain('LIN-1')
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'c2',
                      type: 'function',
                      function: { name: 'mcp__linear__create_issue', arguments: '{"title":"Fix OAuth retry"}' },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 25, total_tokens: 145 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      const lastToolMsg = (reqBody.messages ?? []).filter((m) => m.role === 'tool').pop()
      expect(lastToolMsg?.content).toContain('LIN-2')
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({ status: 'ready', summary: '已查询 LIN-1 并经审批创建 LIN-2。' }),
              },
            },
          ],
          usage: { prompt_tokens: 140, completion_tokens: 30, total_tokens: 170 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const runtime = new OpenAiTurnRuntime({
      baseUrl: 'https://llm.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      temperature: 0,
      maxOutputTokens: 1024,
      maxSteps: 6,
      inputCostPer1M: 0,
      outputCostPer1M: 0,
      fetchImpl: llmFetch,
    })

    const ran1 = await dispatchOnce({
      db: h.ctx.db,
      executor: new RuntimeExecutor(runtime),
      now: h.ctx.now,
      worktreeRoot: workDir,
      artifactsRoot: workDir,
      sandbox: new LocalProcessSandboxProvider(workDir),
      mcpClient,
    })
    expect(ran1).toBe(true)

    expect(mcpCalls.some((c) => c.tool === 'list_issues')).toBe(true)
    expect(mcpCalls.some((c) => c.tool === 'create_issue')).toBe(false)

    const [approval] = await h.ctx.db.select().from(actionApprovals).where(eq(actionApprovals.projectId, projectId))
    expect(approval?.status).toBe('pending')
    expect(approval?.toolName).toBe('mcp:linear:create_issue')

    const decideRes = await api(h, 'POST', `/v1/projects/${projectId}/approvals/${approval!.id}/decide`, {
      cookie,
      body: { decision: 'approved', comment: '可以建单' },
    })
    expect(decideRes.status).toBe(200)

    const ran2 = await dispatchOnce({
      db: h.ctx.db,
      executor: new RuntimeExecutor(runtime),
      now: h.ctx.now,
      worktreeRoot: workDir,
      artifactsRoot: workDir,
      sandbox: new LocalProcessSandboxProvider(workDir),
      mcpClient,
    })
    expect(ran2).toBe(true)
    expect(mcpCalls.some((c) => c.tool === 'create_issue')).toBe(true)

    const [ticket] = await h.ctx.db.select().from(tickets).where(eq(tickets.projectId, projectId))
    expect(ticket?.stage).toBe('answer')
    const allTurns = await h.ctx.db.select().from(sessionTurns).where(eq(sessionTurns.projectId, projectId))
    expect(allTurns.some((t) => t.kind === 'resume' && t.status === 'succeeded')).toBe(true)
  })
})
