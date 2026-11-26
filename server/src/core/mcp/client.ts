import { spawn } from 'node:child_process'
import type { McpToolDescriptor } from '../../db/schema.js'

export interface McpServerTarget {
  id: string
  name: string
  transport: 'stdio' | 'streamable_http' | 'sse'
  endpointOrCmd: string
  args: string[]
  envRefs: Record<string, string>
  defaultToolPolicy?: string
}

export interface McpClientOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: string | number
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

function resolveEnvRefs(envRefs: Record<string, string>, hostEnv: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [targetKey, sourceRef] of Object.entries(envRefs ?? {})) {
    const value = hostEnv[sourceRef]
    if (value !== undefined) out[targetKey] = value
  }
  return out
}

function parseSseOrJson(text: string): JsonRpcResponse {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('empty MCP response')
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as JsonRpcResponse
  }
  // Parse Server-Sent Events `data:` frames (Streamable HTTP / SSE MCP servers).
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
  for (let i = dataLines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(dataLines[i]!) as JsonRpcResponse
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // try previous frame
    }
  }
  throw new Error(`unable to parse MCP response: ${trimmed.slice(0, 200)}`)
}

/**
 * Lightweight MCP (Model Context Protocol) JSON-RPC 2.0 client supporting
 * Streamable HTTP / SSE endpoints and local stdio MCP server processes.
 */
export class McpClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly hostEnv: NodeJS.ProcessEnv

  constructor(options: McpClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.hostEnv = options.env ?? process.env
  }

  async discoverTools(server: McpServerTarget, signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    const result = await this.rpc(server, 'tools/list', {}, signal)
    const rawTools = (result as { tools?: unknown[] } | null)?.tools
    if (!Array.isArray(rawTools)) return []
    const descriptors: McpToolDescriptor[] = []
    for (const item of rawTools) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (typeof record.name !== 'string' || !record.name.trim()) continue
      descriptors.push({
        name: record.name.trim(),
        ...(typeof record.description === 'string' ? { description: record.description } : {}),
        ...(record.inputSchema && typeof record.inputSchema === 'object'
          ? { inputSchema: record.inputSchema as Record<string, unknown> }
          : {}),
      })
    }
    return descriptors
  }

  async callTool(
    server: McpServerTarget,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.rpc(server, 'tools/call', { name: toolName, arguments: args }, signal)
  }

  private async rpc(
    server: McpServerTarget,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (server.transport === 'stdio') {
      return this.rpcStdio(server, method, params, signal)
    }
    return this.rpcHttp(server, method, params, signal)
  }

  private async rpcHttp(
    server: McpServerTarget,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const resolvedEnv = resolveEnvRefs(server.envRefs, this.hostEnv)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    for (const [key, value] of Object.entries(resolvedEnv)) {
      if (key.toLowerCase() === 'authorization') {
        headers.authorization = value
      } else if (key.toUpperCase().startsWith('HEADER_')) {
        headers[key.slice(7).replace(/_/g, '-').toLowerCase()] = value
      }
    }

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const initRes = await this.fetchImpl(server.endpointOrCmd, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'superagent-platform', version: '0.2.0' },
          },
        }),
        signal: controller.signal,
      })
      const sessionId = initRes.headers.get('mcp-session-id')
      if (sessionId) headers['mcp-session-id'] = sessionId
      // Consume init response body without failing if server ignores initialize.
      await initRes.text().catch(() => {})

      const callRes = await this.fetchImpl(server.endpointOrCmd, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
        signal: controller.signal,
      })
      const bodyText = await callRes.text()
      if (!callRes.ok) {
        throw new Error(`MCP HTTP ${callRes.status}: ${bodyText.slice(0, 300)}`)
      }
      const parsed = parseSseOrJson(bodyText)
      if (parsed.error) {
        throw new Error(`MCP error (${parsed.error.code ?? -1}): ${parsed.error.message ?? 'unknown'}`)
      }
      return parsed.result ?? {}
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async rpcStdio(
    server: McpServerTarget,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const resolvedEnv = resolveEnvRefs(server.envRefs, this.hostEnv)
    return new Promise((resolve, reject) => {
      const child = spawn(server.endpointOrCmd, server.args ?? [], {
        env: { ...this.hostEnv, ...resolvedEnv },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let buffer = ''
      let stderr = ''
      let settled = false

      const finish = (err: Error | null, value?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        child.kill('SIGTERM')
        if (err) reject(err)
        else resolve(value)
      }

      const onAbort = () => finish(new Error('MCP stdio request aborted'))
      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      const timer = setTimeout(() => {
        finish(new Error(`MCP stdio timed out after ${this.timeoutMs}ms${stderr ? `: ${stderr.slice(0, 200)}` : ''}`))
      }, this.timeoutMs)

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })

      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('{')) continue
          try {
            const msg = JSON.parse(trimmed) as JsonRpcResponse
            if (msg.id === 2) {
              if (msg.error) {
                finish(new Error(`MCP error (${msg.error.code ?? -1}): ${msg.error.message ?? 'unknown'}`))
              } else {
                finish(null, msg.result ?? {})
              }
              return
            }
          } catch {
            // ignore non-JSON stdout lines
          }
        }
      })

      child.on('error', (error) => finish(error))
      child.on('close', (code) => {
        if (!settled) {
          finish(new Error(`MCP stdio exited with code ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`))
        }
      })

      const initPayload = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'superagent-platform', version: '0.2.0' },
        },
      })
      const callPayload = JSON.stringify({ jsonrpc: '2.0', id: 2, method, params })
      child.stdin?.write(`${initPayload}\n${callPayload}\n`)
    })
  }
}

export function mcpQualifiedToolName(serverName: string, toolName: string): string {
  const safeServer = serverName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_')
  return `mcp:${safeServer}:${toolName}`
}
