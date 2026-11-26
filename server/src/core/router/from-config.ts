import type { Config } from '../../config.js'
import { LlmRouterModel } from './llm-model.js'
import { RuleBasedRouterModel } from './model.js'
import type { RouterModel } from './model.js'

/** Build the configured Router model; LLM mode fails fast without a key. */
export function routerModelFromConfig(config: Config): RouterModel {
  if (config.CORE_ROUTER !== 'llm') return new RuleBasedRouterModel()
  if (config.LLM_API_KEY === undefined || config.LLM_API_KEY.length === 0) {
    throw new Error('LLM_API_KEY is required when CORE_ROUTER=llm')
  }
  return new LlmRouterModel({
    baseUrl: config.LLM_BASE_URL,
    apiKey: config.LLM_API_KEY,
    model: config.LLM_MODEL,
    temperature: 0.1,
    inputCostPer1M: config.LLM_INPUT_COST_PER_1M,
    outputCostPer1M: config.LLM_OUTPUT_COST_PER_1M,
  })
}
