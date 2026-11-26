import type { BotToolPolicy, ToolRiskDecision } from '../../db/schema.js'

const HIGH_RISK_TOOL_PATTERNS = [
  /^github_push/i,
  /^send_email/i,
  /^im_broadcast/i,
  /delete|drop|destroy|publish|deploy|merge|charge|pay|send|post_external/i,
]

const ALWAYS_CONFIRM_TOOLS = new Set([
  'github_push_and_pr',
  'send_email',
  'im_broadcast',
])

const ALWAYS_DENY_COMMAND_PATTERNS = [
  /\bgit\b[^\n;&|]*\s+push(\s|$)/i,
  /(^|\s)gh\s+pr(\s|$)/i,
  /\bgit\b[^\n;&|]*\s+remote\s+(add|set-url|remove)(\s|$)/i,
]

export interface ToolGateDecision {
  decision: ToolRiskDecision
  riskLevel: 'medium' | 'high'
  reason: string
}

/**
 * Evaluate whether a tool call should execute automatically (`allow`), pause
 * for human approval (`confirm`), or be rejected (`deny`).
 */
export function evaluateToolPolicy(
  policy: BotToolPolicy | null | undefined,
  toolName: string,
  args: Record<string, unknown>,
): ToolGateDecision {
  if (toolName === 'run_command' && typeof args.command === 'string') {
    for (const pattern of ALWAYS_DENY_COMMAND_PATTERNS) {
      if (pattern.test(args.command)) {
        return { decision: 'deny', riskLevel: 'high', reason: '平台禁止直接推送/改 remote，由平台统一交付 PR' }
      }
    }
  }

  const explicit = policy?.rules?.[toolName]
  if (explicit !== undefined) {
    return {
      decision: explicit,
      riskLevel: HIGH_RISK_TOOL_PATTERNS.some((p) => p.test(toolName)) ? 'high' : 'medium',
      reason: `Bot 工具策略配置为 ${explicit}`,
    }
  }

  if (policy?.allowedTools && policy.allowedTools.length > 0 && !toolName.startsWith('mcp:')) {
    if (!policy.allowedTools.includes(toolName)) {
      return { decision: 'deny', riskLevel: 'medium', reason: `该 Bot 未授权使用工具 ${toolName}` }
    }
  }

  if (ALWAYS_CONFIRM_TOOLS.has(toolName)) {
    return { decision: 'confirm', riskLevel: 'high', reason: '高风险对外动作需要人工确认' }
  }

  if (toolName.startsWith('mcp:')) {
    const isMutating = HIGH_RISK_TOOL_PATTERNS.some((pattern) => pattern.test(toolName))
    if (isMutating) {
      return { decision: 'confirm', riskLevel: 'high', reason: '外部 MCP 写入/发送操作默认需要人工确认（Suggest, don’t send）' }
    }
  }

  return { decision: 'allow', riskLevel: 'medium', reason: '工作区内低风险操作' }
}

/** Build a human-readable preview object for Web Inbox & IM approval cards. */
export function buildApprovalPreview(
  toolName: string,
  args: Record<string, unknown>,
  riskLevel: 'medium' | 'high',
): { title: string; riskLevel: 'medium' | 'high'; preview: Record<string, unknown> } {
  if (toolName === 'run_command') {
    const cmd = typeof args.command === 'string' ? args.command.slice(0, 500) : ''
    return {
      title: `执行命令：${cmd.slice(0, 60) || 'shell'}`,
      riskLevel,
      preview: { summary: `准备在工作区执行命令`, command: cmd },
    }
  }
  if (toolName.startsWith('mcp:')) {
    return {
      title: `调用外部连接器：${toolName}`,
      riskLevel,
      preview: { summary: `准备调用 MCP 工具 ${toolName}`, arguments: args },
    }
  }
  return {
    title: `待确认操作：${toolName}`,
    riskLevel,
    preview: { summary: `准备执行 ${toolName}`, arguments: args },
  }
}
