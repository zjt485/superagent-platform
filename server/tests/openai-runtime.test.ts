import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { OpenAiTurnRuntime } from '../src/core/agent/openai.js'
import type { ExecutorTurnPacket, MainTurnPacket, TurnRuntimeInput } from '../src/core/agent/types.js'

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

function completion(content: string | null, toolCalls?: unknown[], usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function runtime(responses: Response[], overrides: Partial<ConstructorParameters<typeof OpenAiTurnRuntime>[0]> = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const response = responses.shift()
    if (!response) throw new Error('unexpected fetch')
    return response
  }) as typeof fetch
  return {
    calls,
    runtime: new OpenAiTurnRuntime({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'test-key',
      model: 'test-model',
      temperature: 0,
      maxOutputTokens: 1000,
      maxSteps: 5,
      inputCostPer1M: 1,
      outputCostPer1M: 2,
      fetchImpl,
      ...overrides,
    }),
  }
}

function executorInput(workspace: string, events: unknown[]): TurnRuntimeInput {
  return {
    role: 'executor',
    projectId: 'project',
    sessionId: 'session',
    turnId: 'turn',
    ticketId: 'ticket',
    workspace,
    prompt: 'EXECUTOR SYSTEM PROMPT',
    packet: { role: 'executor' } as ExecutorTurnPacket,
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    env: {},
    onEvent: async (event) => {
      events.push(event)
    },
  }
}

describe('OpenAI-compatible runtime', () => {
  it('parses a Main Session decisions response and tracks usage cost', async () => {
    const { runtime: agent, calls } = runtime([
      completion('```json\n{"decisions":[{"triggerId":"trigger-1","action":"ignore","reason":"not a request"}]}\n```'),
    ])
    const result = await agent.run({
      role: 'main',
      projectId: 'project',
      sessionId: 'session',
      turnId: 'turn',
      prompt: 'MAIN SYSTEM PROMPT',
      packet: { role: 'main' } as MainTurnPacket,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      env: {},
      onEvent: async () => {},
    })
    expect(result.output).toEqual({ decisions: [{ triggerId: 'trigger-1', action: 'ignore', reason: 'not a request' }] })
    expect(result.tokens).toBe(15)
    expect(result.cost).toBeCloseTo((10 / 1_000_000) * 1 + (5 / 1_000_000) * 2)
    expect(calls[0]?.url).toBe('https://llm.example/v1/chat/completions')
    expect(calls[0]?.body.model).toBe('test-model')
  })

  it('executes workspace tools and returns a final Executor report', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openai-runtime-'))
    dirs.push(dir)
    const events: unknown[] = []
    const { runtime: agent, calls } = runtime([
      completion(null, [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/hello.txt', content: 'hello from the executor' }),
          },
        },
      ]),
      completion(JSON.stringify({ status: 'ready', summary: 'created the file' })),
    ])
    const result = await agent.run(executorInput(dir, events))
    expect(result.output).toEqual({ status: 'ready', summary: 'created the file' })
    expect(await readFile(path.join(dir, 'src/hello.txt'), 'utf8')).toBe('hello from the executor')
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool_call', message: 'write_file' }),
        expect.objectContaining({ type: 'tool_result', message: 'write_file' }),
      ]),
    )
    const secondMessages = calls[1]?.body.messages as { role: string; content: string }[]
    expect(secondMessages.some((message) => message.role === 'tool' && message.content.includes('"bytes"'))).toBe(true)
  })

  it('runs a workspace command through the sanitized shell environment', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openai-runtime-'))
    dirs.push(dir)
    const { runtime: agent, calls } = runtime([
      completion(null, [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'run_command',
            arguments: JSON.stringify({ command: 'node -e "console.log(123)"' }),
          },
        },
      ]),
      completion(JSON.stringify({ status: 'ready', summary: 'command passed' })),
    ])
    const result = await agent.run(executorInput(dir, []))
    expect(result.output).toMatchObject({ status: 'ready' })
    const secondMessages = calls[1]?.body.messages as { role: string; content: string }[]
    expect(secondMessages.some((message) => message.role === 'tool' && message.content.includes('123'))).toBe(true)
  })

  it('rejects tool paths outside the workspace without crashing the turn', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openai-runtime-'))
    dirs.push(dir)
    const { runtime: agent, calls } = runtime([
      completion(null, [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: '../../secret.txt' }) },
        },
      ]),
      completion(JSON.stringify({ status: 'blocked', summary: 'cannot read outside workspace' })),
    ])
    const result = await agent.run(executorInput(dir, []))
    expect(result.output).toMatchObject({ status: 'blocked' })
    const secondMessages = calls[1]?.body.messages as { role: string; content: string }[]
    expect(secondMessages.some((message) => message.role === 'tool' && message.content.includes('escapes the workspace'))).toBe(true)
  })

  it('fails clearly when the model never returns a report', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openai-runtime-'))
    dirs.push(dir)
    const { runtime: agent } = runtime([])
    await expect(agent.run(executorInput(dir, []))).rejects.toThrow('unexpected fetch')
  })
})
