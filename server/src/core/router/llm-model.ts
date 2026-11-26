import type { RouterOutput } from '../domain/types.js'
import { parseRouterOutput } from './output.js'
import type { RouterDecisionContext, RouterModel } from './model.js'

export interface LlmRouterOptions {
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
  maxTokens?: number
  jsonMode?: boolean
  inputCostPer1M?: number
  outputCostPer1M?: number
  fetchImpl?: typeof fetch
  maxAttempts?: number
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

const SYSTEM_PROMPT = [
  '你是多项目 Agent 平台的 Router。',
  '读取用户给出的状态板，为「This batch」里的每一条 Trigger 恰好返回一个 decision。',
  '只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。',
  '格式：',
  '{"summary":"一句话总结","items":[{"triggerId":"...","action":"new|attach|ignore|stop|command","ticketId":"...","title":"...","body":"...","scope":"...","planApproval":"required|auto","priority":"low|normal|high|urgent","reason":"...","confidence":0.0}]}',
  '规则：',
  '- new 必须给 title；attach / stop 必须给 ticketId（状态板中工单的 id 或 shortName）；ignore/command 不需要 ticketId。',
  '- 每条 Trigger 只能出现一次，不要发明状态板里没有的 triggerId。',
  '- 只有明确的任务才 new；闲聊 ignore；指向已有工单的追问 attach；要求停止 stop。',
].join('\n')

function extractJson(value: unknown): unknown {
  if (typeof value === 'object' && value !== null) return value
  if (typeof value !== 'string') throw new Error('router response has no content')
  const trimmed = value.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return JSON.parse(fenced?.[1] ?? trimmed)
}

/** OpenAI-compatible single-call Router. The model only returns decisions JSON. */
export class LlmRouterModel implements RouterModel {
  readonly name = 'llm'
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: LlmRouterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async decide(context: RouterDecisionContext): Promise<RouterOutput> {
    const attempts = this.options.maxAttempts ?? 2
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.options.apiKey.length > 0 ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.options.model,
            temperature: this.options.temperature ?? 0.1,
            ...(this.options.maxTokens === undefined ? {} : { max_tokens: this.options.maxTokens }),
            ...(this.options.jsonMode === true ? { response_format: { type: 'json_object' } } : {}),
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: context.board },
            ],
          }),
        })
        if (!response.ok) throw new Error(`router request failed: HTTP ${response.status}`)
        const body = (await response.json()) as ChatResponse
        const content = body.choices?.[0]?.message?.content
        const parsed = parseRouterOutput(extractJson(content))
        if (body.usage !== undefined) {
          const promptTokens = Number(body.usage.prompt_tokens ?? 0) || 0
          const outputTokens = Number(body.usage.completion_tokens ?? 0) || 0
          const totalTokens = Number(body.usage.total_tokens ?? promptTokens + outputTokens) || 0
          const cost =
            (promptTokens / 1_000_000) * (this.options.inputCostPer1M ?? 0) +
            (outputTokens / 1_000_000) * (this.options.outputCostPer1M ?? 0)
          return {
            ...parsed,
            usage: {
              promptTokens,
              outputTokens,
              totalTokens,
              ...(cost > 0 ? { cost } : {}),
            },
          }
        }
        return parsed
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
}
