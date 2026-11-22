import { describe, expect, it } from 'vitest'

import type { ExecutorTurnPacket, TurnRuntime, TurnRuntimeInput, TurnRuntimeResult } from '../../src/dual/types.js'
import { RuntimeExecutor, reportFromRuntime } from '../../src/core/worker/runtime-executor.js'
import type { TurnContext } from '../../src/core/worker/executor.js'

class FakeRuntime implements TurnRuntime {
  readonly name = 'fake'
  calls: TurnRuntimeInput[] = []

  constructor(private readonly output: unknown) {}

  async run(input: TurnRuntimeInput): Promise<TurnRuntimeResult> {
    this.calls.push(input)
    return { output: this.output, tokens: 7, cost: 0.02 }
  }
}

const packet: ExecutorTurnPacket = {
  role: 'executor',
  project: { id: 'p1', name: 'Demo', slug: 'demo', policyVersion: 'v1', policy: {} },
  ticket: {
    id: 't1',
    title: 'Fix login',
    body: 'details',
    plan: null,
    planApproved: false,
    branch: 'agent/t-abc123',
    prUrl: null,
    requesterName: 'Alice',
  },
  mandate: { scope: 'frontend', strength: 'explicit', policyVersion: 'v1', matchedRules: [] },
  inputs: [],
  latestReport: null,
  transcript: [],
  workspaceReady: true,
}

const context: TurnContext = {
  turnId: 'turn-1',
  sessionId: 'session-1',
  projectId: 'p1',
  projectName: 'Demo',
  projectSlug: 'demo',
  ticketId: 't1',
  ticketShortName: 't-abc123',
  ticketTitle: 'Fix login',
  ticketBody: 'details',
  seq: 1,
  worktreePath: '/tmp/ticket',
  transcriptPath: '/tmp/transcript.jsonl',
  inputs: ['make it 30s'],
  model: 'deepseek',
  prompt: 'system prompt',
  packet,
  timeoutMs: 1000,
}

describe('runtime executor', () => {
  it('passes the workspace, prompt and packet to the runtime and maps the report', async () => {
    const runtime = new FakeRuntime({
      status: 'ready',
      summary: 'changed the timeout',
      changedFiles: ['src/login.ts'],
      branch: 'agent/t-abc123',
    })
    const executor = new RuntimeExecutor(runtime)
    const report = await executor.run(context)

    expect(report.status).toBe('ready')
    expect(report.summary).toBe('changed the timeout')
    expect(report.changedFiles).toEqual(['src/login.ts'])
    expect(report.tokens).toBe(7)
    expect(report.cost).toBe(0.02)
    expect(runtime.calls[0]?.workspace).toBe('/tmp/ticket')
    expect(runtime.calls[0]?.prompt).toBe('system prompt')
    expect(runtime.calls[0]?.packet).toBe(packet)
  })

  it('maps an invalid runtime output to a failed report', () => {
    const report = reportFromRuntime({ status: 'nope' }, 0, 0)
    expect(report.status).toBe('failed')
    expect(report.summary).toContain('invalid report')
  })
})
