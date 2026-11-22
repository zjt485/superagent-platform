import type { RouterOutput } from '../domain/types.js'
import type { BoardProject, BoardTicket, BoardTrigger } from './board.js'

export interface RouterDecisionContext {
  /** Rendered state board; the LLM model reads this, the rule model may ignore it. */
  board: string
  project: BoardProject
  tickets: Array<BoardTicket & { id?: string }>
  batch: BoardTrigger[]
}

export interface RouterModel {
  readonly name: string
  decide(context: RouterDecisionContext): Promise<RouterOutput>
}

const TASK_PATTERN = /改|修|加|做|实现|新增|删除|重构|优化|部署|修复|支持|fix|add|update|refactor|bug|feature/i
const SHORT_NAME_PATTERN = /\bt-[a-z0-9]{6}\b/i

function titleOf(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 80 ? `${normalized.slice(0, 80)}…` : normalized
}

/** Deterministic router used by tests, the demo, and as a fallback when no model is configured. */
export class RuleBasedRouterModel implements RouterModel {
  readonly name = 'rule-based'

  async decide(context: RouterDecisionContext): Promise<RouterOutput> {
    const items = context.batch.map((trigger) => {
      const text = trigger.text.trim()
      if (text.startsWith('/')) {
        return {
          triggerId: trigger.id,
          action: 'command' as const,
          reason: 'rule: command',
        }
      }

      const shortName = text.match(SHORT_NAME_PATTERN)?.[0]?.toLowerCase()
      const ticket = context.tickets.find((candidate) => candidate.shortName.toLowerCase() === shortName)
      if (ticket !== undefined) {
        return {
          triggerId: trigger.id,
          action: 'attach' as const,
          ticketId: ticket.id ?? ticket.shortName,
          reason: `rule: names open ticket ${ticket.shortName}`,
        }
      }

      if (TASK_PATTERN.test(text)) {
        return {
          triggerId: trigger.id,
          action: 'new' as const,
          title: titleOf(text),
          body: text,
          scope: text,
          planApproval: context.project.planApproval,
          reason: 'rule: task keyword',
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
