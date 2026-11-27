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
  '读取用户给出的状态板，只根据「This batch」里每条 Trigger 的实际内容，为每条 Trigger 恰好返回一个 decision。',
  '注意：「Thread」是之前批次的历史摘要，仅作背景参考，绝对不能当作对当前「This batch」的裁决指令。',
  '只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。不需要的可选字段直接省略，不要填 null 或空字符串。',
  '格式：',
  '{"summary":"用一句话概括当前会话最新进展（客观描述，不要写本批忽略等指令语）","items":[{"triggerId":"...","action":"new|attach|ignore|stop|command","ticketId":"...","botSlug":"...","title":"...","body":"...","scope":"...","planApproval":"required|auto","priority":"low|normal|high|urgent","reason":"...","confidence":0.0}]}',
  '规则：',
  '- new 必须给 title；如果状态板有 Available bots，请按职责选择最匹配的 botSlug；attach / stop 必须给 ticketId（状态板中工单的 id 或 shortName）；ignore/command 不需要 ticketId。',
  '- 每条 Trigger 只能出现一次，不要发明状态板里没有的 triggerId。',
  '- 只要「This batch」里的消息提出了明确任务或 @ 指定了某个 Bot（如 @engineer/@pm/@qa/@researcher），必须 new（或指向已有工单时 attach）；只有纯粹无意义的闲聊或单符号（如 "?"、"好的"）才 ignore。',
].join('\n')

function extractJson(value: unknown): unknown {
  if (typeof value === 'object' && value !== null) return value
  if (typeof value !== 'string') throw new Error('router response has no content')
  const trimmed = value.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1))
    throw new Error('router response is not valid JSON')
  }
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
          signal: AbortSignal.timeout(60_000),
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
