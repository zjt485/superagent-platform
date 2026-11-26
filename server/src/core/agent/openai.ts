import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { McpServerRow } from '../../db/schema.js'
import { McpClient, mcpQualifiedToolName } from '../mcp/client.js'
import type { TurnRuntime, TurnRuntimeInput, TurnRuntimeResult } from './types.js'
import { buildApprovalPreview, evaluateToolPolicy } from './gate.js'

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

const BROWSER_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description: 'Open an HTTP/HTTPS URL in the Bot browser and inspect its title and content excerpt.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'HTTP or HTTPS URL to open' } },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element or link on the current page by CSS selector or link text.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'CSS selector or visible link text' } },
        required: ['selector'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input element matched by a CSS selector on the current page.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the input element' },
          text: { type: 'string', description: 'Text to fill into the input' },
        },
        required: ['selector', 'text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_extract',
      description: 'Extract readable text and links from the current browser page or a specific selector.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Optional CSS selector or HTML tag' },
          max_chars: { type: 'number', description: 'Max characters to return (default 6000)' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Capture a screenshot of the current browser page and attach it as an artifact visible in the Live Inspector.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short caption for the screenshot' },
          full_page: { type: 'boolean', description: 'Whether to capture the full scrollable page' },
        },
        additionalProperties: false,
      },
    },
  },
] as const

interface ResolvedMcpTool {
  server: McpServerRow
  toolName: string
  canonicalName: string
}

function buildToolCatalog(input: TurnRuntimeInput): {
  tools: unknown[]
  mcpIndex: Map<string, ResolvedMcpTool>
} {
  const tools: unknown[] = [...TOOL_DEFINITIONS]
  if (input.browser) {
    tools.push(...BROWSER_TOOL_DEFINITIONS)
  }
  const mcpIndex = new Map<string, ResolvedMcpTool>()
  for (const server of input.mcpServers ?? []) {
    if (!server.enabled) continue
    for (const descriptor of server.cachedTools ?? []) {
      const safeServer = server.name.replace(/[^a-zA-Z0-9_-]/g, '_')
      const safeTool = descriptor.name.replace(/[^a-zA-Z0-9_-]/g, '_')
      const llmName = `mcp__${safeServer}__${safeTool}`.slice(0, 64)
      const canonicalName = mcpQualifiedToolName(server.name, descriptor.name)
      const entry: ResolvedMcpTool = { server, toolName: descriptor.name, canonicalName }
      mcpIndex.set(llmName, entry)
      mcpIndex.set(canonicalName, entry)
      tools.push({
        type: 'function',
        function: {
          name: llmName,
          description: `[MCP ${server.name}] ${descriptor.description ?? descriptor.name}`,
          parameters: descriptor.inputSchema ?? { type: 'object', properties: {} },
        },
      })
    }
  }
  return { tools, mcpIndex }
}

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
    let messages: ChatMessage[] = [
      { role: 'system', content: input.prompt },
      {
        role: 'user',
        content:
          '这是直连模型运行。使用工具在工作区内完成实现和验证；不要 push、不要创建 PR。完成后直接返回报告 JSON 对象（status/summary/...），不要写 .superagent/result.json，也不要包 output 字段。',
      },
    ]

    const { tools, mcpIndex } = buildToolCatalog(input)

    if (input.resumeFrom) {
      const { checkpoint, decision, comment } = input.resumeFrom
      messages = [...(checkpoint.messages as ChatMessage[])]
      const pending = checkpoint.pendingToolCall
      await input.onEvent({
        type: 'approval_resolved',
        message: `${pending.name}: ${decision}`,
        payload: { toolName: pending.name, decision, comment: comment ?? null },
      })
      if (decision === 'approved') {
        const result = await this.executeTool(pending.name, pending.arguments, input, mcpIndex)
        messages.push({ role: 'tool', tool_call_id: pending.id, content: result })
      } else {
        messages.push({
          role: 'tool',
          tool_call_id: pending.id,
          content: JSON.stringify({
            approved: false,
            decision,
            comment: comment || '人工拒绝执行此高风险操作，请根据反馈调整方案。',
          }),
        })
      }
    }

    let pendingHandoff: { toBotSlug: string; summary: string; context: string; expectedOutput?: string } | null = null
    for (let step = 0; step < this.options.maxSteps; step += 1) {
      const completion = await this.chat(messages, tools, signal)
      account(completion.usage)
      const message = completion.choices?.[0]?.message
      if (!message) throw new Error('model returned an empty Executor response')
      const toolCalls = message.tool_calls ?? []
      if (toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls })
        for (const call of toolCalls) {
          let parsedArgs: JsonObject = {}
          try {
            const raw = JSON.parse(call.function.arguments || '{}') as unknown
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) parsedArgs = raw as JsonObject
          } catch {
            // let executeTool report invalid arguments
          }

          const mcpTarget = mcpIndex.get(call.function.name)
          const gate = evaluateToolPolicy(
            input.toolPolicy,
            call.function.name,
            parsedArgs,
            mcpTarget
              ? { mcpDefaultPolicy: mcpTarget.server.defaultToolPolicy, canonicalName: mcpTarget.canonicalName }
              : {},
          )
          const displayToolName = mcpTarget?.canonicalName ?? call.function.name
          if (gate.decision === 'deny') {
            await input.onEvent({ type: 'tool_denied', message: `${displayToolName}: ${gate.reason}` })
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ error: `blocked by tool policy: ${gate.reason}` }),
            })
            continue
          }
          if (gate.decision === 'confirm') {
            const preview = buildApprovalPreview(displayToolName, parsedArgs, gate.riskLevel)
            await input.onEvent({
              type: 'approval_requested',
              message: preview.title,
              payload: { toolName: displayToolName, riskLevel: gate.riskLevel },
            })
            return {
              status: 'waiting',
              summary: `操作「${preview.title}」需要人工审批后继续执行。`,
              approvalRequest: {
                toolName: displayToolName,
                toolCallId: call.id,
                riskLevel: preview.riskLevel,
                title: preview.title,
                preview: preview.preview,
                toolArgs: parsedArgs,
                checkpoint: {
                  messages,
                  pendingToolCall: {
                    id: call.id,
                    name: call.function.name,
                    arguments: call.function.arguments,
                    args: parsedArgs,
                  },
                },
              },
            }
          }

          if (call.function.name === 'handoff') {
            try {
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
          const result = await this.executeTool(call.function.name, call.function.arguments, input, mcpIndex)
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

  private async executeTool(
    name: string,
    rawArguments: string,
    input: TurnRuntimeInput,
    mcpIndex: Map<string, ResolvedMcpTool>,
  ): Promise<string> {
    let args: JsonObject
    try {
      const parsed = JSON.parse(rawArguments || '{}') as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('arguments must be an object')
      args = parsed as JsonObject
    } catch (error) {
      return JSON.stringify({ error: `invalid tool arguments: ${error instanceof Error ? error.message : String(error)}` })
    }
    const workspace = path.resolve(input.workspace as string)
    const mcpTarget = mcpIndex.get(name)
    const eventName = mcpTarget?.canonicalName ?? name
    await input.onEvent({ type: 'tool_call', message: eventName, payload: summaryFor(eventName, args) })
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
        if (input.sandbox) {
          const res = await input.sandbox.execStream({
            botId: input.sandboxBotId ?? 'default',
            workspacePath: workspace,
            command,
            timeoutMs: timeout,
            ...(input.sandboxConfig ? { sandboxConfig: input.sandboxConfig } : {}),
            signal: input.signal,
            onChunk: async (stream, chunk) => {
              await input.onEvent({
                type: 'terminal_chunk',
                message: chunk.slice(0, 1000),
                payload: { stream, chunk: chunk.slice(0, 2000), command: command.slice(0, 200) },
              })
            },
          })
          output = commandResult(res.exitCode, res.stdout, res.stderr)
        } else {
          output = await this.runCommand(workspace, command, timeout)
        }
      } else if (name === 'browser_open') {
        if (!input.browser) throw new Error('browser tools are disabled for this bot')
        const url = typeof args.url === 'string' ? args.url.trim() : ''
        if (!url) throw new Error('url is required')
        output = JSON.stringify(await input.browser.open(url))
      } else if (name === 'browser_click') {
        if (!input.browser) throw new Error('browser tools are disabled for this bot')
        const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
        output = JSON.stringify(await input.browser.click(selector))
      } else if (name === 'browser_type') {
        if (!input.browser) throw new Error('browser tools are disabled for this bot')
        const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
        const text = typeof args.text === 'string' ? args.text : ''
        output = JSON.stringify(await input.browser.type(selector, text))
      } else if (name === 'browser_extract') {
        if (!input.browser) throw new Error('browser tools are disabled for this bot')
        const selector = typeof args.selector === 'string' ? args.selector : undefined
        const maxChars = typeof args.max_chars === 'number' ? args.max_chars : 6000
        output = JSON.stringify(await input.browser.extract(selector, maxChars))
      } else if (name === 'browser_screenshot') {
        if (!input.browser) throw new Error('browser tools are disabled for this bot')
        const title = typeof args.title === 'string' ? args.title : undefined
        const fullPage = typeof args.full_page === 'boolean' ? args.full_page : false
        output = JSON.stringify(await input.browser.screenshot({ ...(title ? { title } : {}), fullPage }))
      } else if (mcpTarget) {
        const client = input.mcpClient ?? new McpClient()
        const result = await client.callTool(
          {
            id: mcpTarget.server.id,
            name: mcpTarget.server.name,
            transport: mcpTarget.server.transport,
            endpointOrCmd: mcpTarget.server.endpointOrCmd,
            args: mcpTarget.server.args,
            envRefs: mcpTarget.server.envRefs,
            defaultToolPolicy: mcpTarget.server.defaultToolPolicy,
          },
          mcpTarget.toolName,
          args,
          input.signal,
        )
        output = JSON.stringify(result).slice(0, MAX_TOOL_OUTPUT)
      } else {
        throw new Error(`unknown tool: ${name}`)
      }
      await input.onEvent({ type: 'tool_result', message: eventName, payload: { ok: true } })
      return output
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await input.onEvent({ type: 'tool_result', message: eventName, payload: { ok: false, error: message.slice(0, 500) } })
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
