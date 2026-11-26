import { stripMentions } from '../../domain/message.js'
import type { RouterOutput } from '../domain/types.js'
import type { BoardBot, BoardProject, BoardTicket, BoardTrigger } from './board.js'

export interface RouterDecisionContext {
  /** Rendered state board; the LLM model reads this, the rule model may ignore it. */
  board: string
  project: BoardProject
  bots?: BoardBot[]
  tickets: Array<BoardTicket & { id?: string }>
  batch: BoardTrigger[]
}

export interface RouterModel {
  readonly name: string
  decide(context: RouterDecisionContext): Promise<RouterOutput>
}

const TASK_PATTERN = /改|修|加|做|实现|新增|删除|重构|优化|部署|修复|支持|调研|分析|写|测试|巡检|回归|评估|方案|PRD|fix|add|update|refactor|bug|feature|research|test|check|audit/i
const SHORT_NAME_PATTERN = /\bt-[a-z0-9]{6}\b/i

function titleOf(text: string): string {
  const normalized = stripMentions(text).replace(/\s+/g, ' ').trim()
  return normalized.length > 80 ? `${normalized.slice(0, 80)}…` : normalized
}

function pickBotSlug(trigger: BoardTrigger, text: string, bots: BoardBot[] | undefined): string | undefined {
  if (!bots || bots.length === 0) return undefined
  if (trigger.targetBotId) {
    const exact = bots.find((bot) => bot.id === trigger.targetBotId)
    if (exact) return exact.slug
  }
  const mentionMatches = [...trigger.text.matchAll(/[@＠]([a-z0-9][a-z0-9_-]{0,39})\b/gi)]
  for (const match of mentionMatches) {
    const slug = match[1]?.toLowerCase()
    const matched = bots.find((bot) => bot.slug.toLowerCase() === slug)
    if (matched) return matched.slug
  }
  if (/调研|竞品|资料|研究|research|benchmark/i.test(text)) {
    const found = bots.find((bot) => bot.slug === 'researcher')
    if (found) return found.slug
  }
  if (/PRD|产品|需求拆解|验收标准|原型|spec/i.test(text)) {
    const found = bots.find((bot) => bot.slug === 'pm')
    if (found) return found.slug
  }
  if (/QA|巡检|回归|测试|复现|页面报错|verify|test/i.test(text)) {
    const found = bots.find((bot) => bot.slug === 'qa')
    if (found) return found.slug
  }
  return bots.find((bot) => bot.slug === 'engineer')?.slug ?? bots[0]?.slug
}

/** Deterministic router used by tests, the demo, and as a fallback when no model is configured. */
export class RuleBasedRouterModel implements RouterModel {
  readonly name = 'rule-based'

  async decide(context: RouterDecisionContext): Promise<RouterOutput> {
    const items = context.batch.map((trigger) => {
      const text = stripMentions(trigger.text).trim()
      if (text.startsWith('/')) {
        return {
          triggerId: trigger.id,
          action: 'command' as const,
          reason: 'rule: command',
        }
      }

      if (trigger.kind === 'handoff' || trigger.kind === 'routine') {
        const botSlug = pickBotSlug(trigger, text, context.bots)
        return {
          triggerId: trigger.id,
          action: 'new' as const,
          ...(botSlug ? { botSlug } : {}),
          title: titleOf(text),
          body: text,
          scope: text,
          planApproval: context.project.planApproval,
          reason: `rule: ${trigger.kind}`,
        }
      }

      const shortName = text.match(SHORT_NAME_PATTERN)?.[0]?.toLowerCase()
      const namedTicket = context.tickets.find((candidate) => candidate.shortName.toLowerCase() === shortName)
      if (namedTicket !== undefined) {
        return {
          triggerId: trigger.id,
          action: 'attach' as const,
          ticketId: namedTicket.id ?? namedTicket.shortName,
          reason: `rule: names open ticket ${namedTicket.shortName}`,
        }
      }

      if (trigger.address === 'ambient') {
        if (context.project.allowThreadReplies && context.tickets.length === 1) {
          const only = context.tickets[0]!
          return {
            triggerId: trigger.id,
            action: 'attach' as const,
            ticketId: only.id ?? only.shortName,
            reason: `rule: thread follow-up on ${only.shortName}`,
          }
        }
        return {
          triggerId: trigger.id,
          action: 'ignore' as const,
          reason: 'rule: ambient message without active ticket',
        }
      }

      if (TASK_PATTERN.test(text) || trigger.address === 'direct' || trigger.targetBotId) {
        const botSlug = pickBotSlug(trigger, text, context.bots)
        return {
          triggerId: trigger.id,
          action: 'new' as const,
          ...(botSlug ? { botSlug } : {}),
          title: titleOf(text),
          body: text,
          scope: text,
          planApproval: context.project.planApproval,
          reason: trigger.targetBotId ? 'rule: targeted bot request' : 'rule: task keyword',
        }
      }

      return {
        triggerId: trigger.id,
        action: 'ignore' as const,
        reason: 'rule: no task keyword',
      }
    })

    const count = (action: string): number => items.filter((item) => item.action === action).length
    return {
      summary: `rule-based: ${count('new')} new, ${count('attach')} attach, ${count('ignore')} ignore`,
      items,
    }
  }
}
