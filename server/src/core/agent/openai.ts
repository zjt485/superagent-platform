import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TurnRuntime, TurnRuntimeInput, TurnRuntimeResult } from './types.js'

type JsonObject = Record<string, unknown>

interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
}

interface ChatCompletion {
  choices?: { message?: ChatMessage; finish_reason?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

export interface OpenAiRuntimeOptions {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxOutputTokens: number
  maxSteps: number
  inputCostPer1M: number
  outputCostPer1M: number
  fetchImpl?: typeof fetch
  toolTimeoutMs?: number
}

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 file inside the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative file path' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or replace a UTF-8 file inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories inside a workspace directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative directory, defaults to .' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a local build/test command in the workspace. Never use it to push branches, create PRs, or modify git remotes.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command, run with the workspace as cwd' },
          timeout_ms: { type: 'number', description: 'Optional timeout, max 120000ms' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'handoff',
      description: 'Hand off the next stage of work to another teammate Bot in the same project/room (e.g. @pm, @engineer, @qa).',
      parameters: {
        type: 'object',
        properties: {
          to_bot_slug: { type: 'string', description: 'Target teammate bot slug (without @)' },
          summary: { type: 'string', description: 'Brief handoff summary visible in the room' },
          context: { type: 'string', description: 'Detailed findings, specs, or instructions for the next bot' },
          expected_output: { type: 'string', description: 'What deliverable is expected from the next bot' },
        },
        required: ['to_bot_slug', 'summary', 'context'],
        additionalProperties: false,
      },
    },
  },
] as const

const MAX_FILE_BYTES = 200_000
const MAX_TOOL_OUTPUT = 20_000
const MAX_LIST_ENTRIES = 200

function extractJson(content: string): JsonObject {
  let text = content.trim().replace(/^\uFEFF/, '')
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) throw new Error('model did not return a JSON object')
  const parsed = JSON.parse(text.slice(first, last + 1)) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('model JSON is not an object')
  return parsed as JsonObject
}

function unwrapOutput(value: JsonObject): unknown {
  return value.output && typeof value.output === 'object' && !Array.isArray(value.output) ? value.output : value
}

function safeRelative(root: string, value: unknown): string {
  const relative = typeof value === 'string' && value.trim() ? value.trim() : '.'
  const resolved = path.resolve(root, relative)
  const normalizedRoot = path.resolve(root)
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error('path escapes the workspace')
  }
  return resolved
}

function safeEnv(workspace: string): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'LANG', 'LC_ALL', 'CI']
  const home = path.join(workspace, '.agent-home')
  return {
    ...Object.fromEntries(allowed.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: path.join(workspace, '.agent-tmp'),
    TMP: path.join(workspace, '.agent-tmp'),
  }
}

function forbidCommand(command: string): void {
  if (/\bgit\b[^\n;&|]*\s+push(\s|$)/i.test(command)) {
    throw new Error('git push is not allowed from the executor; the platform delivers the PR')
  }
  if (/(^|\s)gh\s+pr(\s|$)/i.test(command)) throw new Error('gh pr is not allowed from the executor')
  if (/\bgit\b[^\n;&|]*\s+remote\s+(add|set-url|remove)(\s|$)/i.test(command)) {
    throw new Error('changing git remotes is not allowed')
  }
}

function summaryFor(name: string, args: JsonObject): JsonObject {
  if (name === 'write_file') {
    return { path: args.path, bytes: typeof args.content === 'string' ? Buffer.byteLength(args.content) : 0 }
  }
  return { ...args, ...(typeof args.command === 'string' ? { command: args.command.slice(0, 500) } : {}) }
}

function commandResult(code: number | null, stdout: string, stderr: string): string {
  return JSON.stringify({
    exit_code: code,
    stdout: stdout.slice(-MAX_TOOL_OUTPUT),
    stderr: stderr.slice(-MAX_TOOL_OUTPUT),
    ...(stdout.length > MAX_TOOL_OUTPUT ? { stdout_truncated: true } : {}),
    ...(stderr.length > MAX_TOOL_OUTPUT ? { stderr_truncated: true } : {}),
  })
}

/**
 * Direct OpenAI-compatible runtime. Primary runtime for the unified core
 * engine: the model executes a workspace tool loop while the platform retains
 * control over policy gates, git delivery and event streaming.
 */
export class OpenAiTurnRuntime implements TurnRuntime {
  readonly name = 'openai'
  private readonly fetchImpl: typeof fetch
  private readonly toolTimeoutMs: number

  constructor(private readonly options: OpenAiRuntimeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.toolTimeoutMs = options.toolTimeoutMs ?? 120_000
  }

  async run(input: TurnRuntimeInput): Promise<TurnRuntimeResult> {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    input.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), input.timeoutMs)
    let tokens = 0
    let cost = 0
    const account = (usage: ChatCompletion['usage']) => {
      const prompt = Number(usage?.prompt_tokens ?? 0)
      const completion = Number(usage?.completion_tokens ?? 0)
      tokens += Number(usage?.total_tokens ?? prompt + completion)
      cost += (prompt / 1_000_000) * this.options.inputCostPer1M
      cost += (completion / 1_000_000) * this.options.outputCostPer1M
    }
    try {
      if (input.role === 'executor') {
        const output = await this.runExecutor(input, controller.signal, account)
        return { output, tokens, cost }
      }
      const output = await this.runMain(input, controller.signal, account)
      return { output, tokens, cost }
    } finally {
      clearTimeout(timer)
      input.signal.removeEventListener('abort', onAbort)
    }
  }

  private async runMain(
    input: TurnRuntimeInput,
    signal: AbortSignal,
    account: (usage: ChatCompletion['usage']) => void,
  ): Promise<unknown> {
    const completion = await this.chat(
      [
        { role: 'system', content: input.prompt },
        {
          role: 'user',
          content:
            '这是直连模型运行：不要写 .superagent/result.json，直接在你的最终消息中返回 decisions JSON 对象。只返回 JSON。',
        },
      ],
      undefined,
      signal,
    )
    account(completion.usage)
    const content = completion.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('model returned an empty Main Session response')
    const parsed = extractJson(content)
    if (!parsed.decisions && parsed.output && typeof parsed.output === 'object') {
      return parsed.output
    }
    return parsed
  }

  private async runExecutor(
    input: TurnRuntimeInput,
    signal: AbortSignal,
    account: (usage: ChatCompletion['usage']) => void,
  ): Promise<unknown> {
    if (!input.workspace) throw new Error('executor runtime requires a workspace')
    const messages: ChatMessage[] = [
      { role: 'system', content: input.prompt },
      {
        role: 'user',
        content:
          '这是直连模型运行。使用工具在工作区内完成实现和验证；不要 push、不要创建 PR。完成后直接返回报告 JSON 对象（status/summary/...），不要写 .superagent/result.json，也不要包 output 字段。',
      },
    ]
    let pendingHandoff: { toBotSlug: string; summary: string; context: string; expectedOutput?: string } | null = null
    for (let step = 0; step < this.options.maxSteps; step += 1) {
      const completion = await this.chat(messages, TOOL_DEFINITIONS, signal)
      account(completion.usage)
      const message = completion.choices?.[0]?.message
      if (!message) throw new Error('model returned an empty Executor response')
      const toolCalls = message.tool_calls ?? []
      if (toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls })
        for (const call of toolCalls) {
          if (call.function.name === 'handoff') {
            try {
              const parsedArgs = JSON.parse(call.function.arguments || '{}') as JsonObject
              const toBotSlug = typeof parsedArgs.to_bot_slug === 'string' ? parsedArgs.to_bot_slug.replace(/^@/, '').trim() : ''
              const summary = typeof parsedArgs.summary === 'string' ? parsedArgs.summary.trim() : ''
              const context = typeof parsedArgs.context === 'string' ? parsedArgs.context.trim() : summary
              const expectedOutput = typeof parsedArgs.expected_output === 'string' ? parsedArgs.expected_output.trim() : undefined
              if (!toBotSlug || !summary) throw new Error('to_bot_slug and summary are required')
              pendingHandoff = { toBotSlug, summary, context, ...(expectedOutput ? { expectedOutput } : {}) }
              await input.onEvent({ type: 'handoff', message: `handoff -> @${toBotSlug}`, payload: pendingHandoff })
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify({ queued: true, to_bot_slug: toBotSlug }),
              })
            } catch (error) {
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              })
            }
            continue
          }
          const result = await this.executeTool(call.function.name, call.function.arguments, input)
          messages.push({ role: 'tool', tool_call_id: call.id, content: result })
        }
        continue
      }
      const content = message.content
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('model returned neither tool calls nor a final report')
      }
      const parsed = extractJson(content)
      const output = unwrapOutput(parsed)
      if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('executor report is not an object')
      if (typeof (output as JsonObject).status !== 'string') throw new Error('executor report is missing status')
      if (pendingHandoff && !(output as JsonObject).handoff) {
        return { ...(output as JsonObject), handoff: pendingHandoff }
      }
      return output
    }
    throw new Error(`executor exceeded the tool step limit (${this.options.maxSteps})`)
  }

  private async chat(messages: ChatMessage[], tools: unknown, signal: AbortSignal): Promise<ChatCompletion> {
    const body = {
      model: this.options.model,
      messages,
      temperature: this.options.temperature,
      max_tokens: this.options.maxOutputTokens,
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
    }
    const response = await this.fetchImpl(this.endpoint(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`LLM request failed with HTTP ${response.status}: ${text.slice(0, 500)}`)
    }
    return (await response.json()) as ChatCompletion
  }

  private endpoint(): string {
    const base = this.options.baseUrl.replace(/\/+$/, '')
    return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  }

  private async executeTool(name: string, rawArguments: string, input: TurnRuntimeInput): Promise<string> {
    let args: JsonObject
    try {
      const parsed = JSON.parse(rawArguments || '{}') as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('arguments must be an object')
      args = parsed as JsonObject
    } catch (error) {
      return JSON.stringify({ error: `invalid tool arguments: ${error instanceof Error ? error.message : String(error)}` })
    }
    const workspace = path.resolve(input.workspace as string)
    await input.onEvent({ type: 'tool_call', message: name, payload: summaryFor(name, args) })
    try {
      let output: string
      if (name === 'read_file') {
        const target = safeRelative(workspace, args.path)
        const content = await readFile(target, 'utf8')
        output = JSON.stringify({ path: path.relative(workspace, target), content: content.slice(0, MAX_FILE_BYTES) })
      } else if (name === 'write_file') {
        const target = safeRelative(workspace, args.path)
        const relative = path.relative(workspace, target)
        if (relative.split(path.sep)[0] === '.git' || relative.split(path.sep)[0] === '.superagent') {
          throw new Error('writing .git or .superagent is not allowed')
        }
        const content = typeof args.content === 'string' ? args.content : ''
        if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error(`file is larger than ${MAX_FILE_BYTES} bytes`)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, content, 'utf8')
        output = JSON.stringify({ path: relative, bytes: Buffer.byteLength(content) })
      } else if (name === 'list_files') {
        const target = safeRelative(workspace, args.path ?? '.')
        const entries = await readdir(target, { withFileTypes: true })
        const visible = entries
          .filter((entry) => !['.git', 'node_modules', '.superagent', 'dist', '.agent-home', '.agent-tmp'].includes(entry.name))
          .slice(0, MAX_LIST_ENTRIES)
          .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
        output = JSON.stringify({ path: path.relative(workspace, target) || '.', entries: visible })
      } else if (name === 'run_command') {
        const command = typeof args.command === 'string' ? args.command.trim() : ''
        if (!command) throw new Error('command is required')
        forbidCommand(command)
        const timeout = Math.min(
          Math.max(Number(args.timeout_ms ?? 120_000), 1000),
          Math.min(120_000, this.toolTimeoutMs),
        )
        output = await this.runCommand(workspace, command, timeout)
      } else {
        throw new Error(`unknown tool: ${name}`)
      }
      await input.onEvent({ type: 'tool_result', message: name, payload: { ok: true } })
      return output
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await input.onEvent({ type: 'tool_result', message: name, payload: { ok: false, error: message.slice(0, 500) } })
      return JSON.stringify({ error: message.slice(0, 1000) })
    }
  }

  private async runCommand(workspace: string, command: string, timeoutMs: number): Promise<string> {
    await mkdir(path.join(workspace, '.agent-home', 'AppData', 'Roaming'), { recursive: true })
    await mkdir(path.join(workspace, '.agent-home', 'AppData', 'Local'), { recursive: true })
    await mkdir(path.join(workspace, '.agent-tmp'), { recursive: true })
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: workspace,
        shell: true,
        env: safeEnv(workspace),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(commandResult(code, stdout, stderr))
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (stdout.length > MAX_TOOL_OUTPUT * 2) stdout = stdout.slice(-MAX_TOOL_OUTPUT * 2)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        if (stderr.length > MAX_TOOL_OUTPUT * 2) stderr = stderr.slice(-MAX_TOOL_OUTPUT * 2)
      })
      child.on('error', (error) => {
        stderr += `\n${error.message}`
        finish(null)
      })
      child.on('close', (code) => finish(code))
      const timer = setTimeout(() => {
        stderr += `\ncommand timed out after ${timeoutMs}ms`
        child.kill('SIGKILL')
        finish(null)
      }, timeoutMs)
    })
  }
}
