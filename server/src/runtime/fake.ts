import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { shortId } from '../domain/ids.js'
import { RuntimeCancelledError, type AgentRuntime, type RuntimeContext, type RuntimeResult } from '../domain/runtime.js'

export interface FakeRuntimeOptions {
  delayMs?: number
  fail?: boolean
}

/**
 * Deterministic runtime for development, demos and tests. It performs a real
 * edit in the workspace so the rest of the pipeline (commit, push, PR) runs
 * exactly as it does with DSH.
 */
export class FakeRuntime implements AgentRuntime {
  readonly name = 'fake'

  constructor(private readonly options: FakeRuntimeOptions = {}) {}

  async run(context: RuntimeContext): Promise<RuntimeResult> {
    const delay = this.options.delayMs ?? 20
    await context.onEvent({ type: 'log', message: `fake runtime started (${context.kind})` })
    await sleep(delay, context.signal)
    if (context.kind === 'plan') {
      const plan = [
        `1. 阅读仓库结构与相关模块，定位「${context.ticketId}」涉及的代码。`,
        '2. 实现需求并补充必要的测试。',
        '3. 运行仓库现有测试与类型检查。',
        '4. 在 `agent/*` 分支提交改动并创建 PR。',
      ].join('\n')
      await sleep(delay, context.signal)
      await context.onEvent({ type: 'plan', message: plan })
      return { summary: '已生成实施计划', plan, tokens: 320, cost: 0.0004 }
    }
    if (this.options.fail) {
      await context.onEvent({ type: 'error', message: 'fake runtime failure requested' })
      throw new Error('fake runtime failure requested')
    }
    const relative = path.join('docs', 'superagent', `ticket-${shortId(context.ticketId)}.md`)
    const absolute = path.join(context.workspace, relative)
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(
      absolute,
      [
        '# Superagent 变更说明',
        '',
        `- 运行：${context.runId}`,
        `- 工单：${context.ticketId}`,
        `- 时间：${new Date().toISOString()}`,
        '',
        '该文件由 fake runtime 生成，用于在没有 DSH 凭据的环境演示完整交付链路。',
        '',
      ].join('\n'),
      'utf8',
    )
    await context.onEvent({ type: 'file', message: relative })
    return {
      summary: `新增 ${relative}，完成需求实现。`,
      tokens: 1200 + Math.floor(context.prompt.length / 4),
      cost: 0.0018,
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new RuntimeCancelledError())
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new RuntimeCancelledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
