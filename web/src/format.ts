export const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  active: '运行中',
  paused: '已暂停',
  archived: '已归档',
  new: '新建',
  triaged: '已受理',
  planned: '待审批',
  running: '执行中',
  waiting_review: '待评审',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  queued: '排队中',
  succeeded: '成功',
  timeout: '超时',
  pending: '待发送',
  sent: '已发送',
  ignored: '已忽略',
  ticket_created: '建单',
  ticket_appended: '追加',
  command: '命令',
  duplicate: '重复',
}

export const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  maintainer: 'Maintainer',
  member: 'Member',
  viewer: 'Viewer',
}

export const PROVIDER_LABELS: Record<string, string> = {
  feishu: '飞书',
  wecom: '企业微信',
  github: 'GitHub',
  dev: '开发账号',
}

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand'

export function statusTone(status: string): Tone {
  if (['active', 'succeeded', 'done', 'sent'].includes(status)) return 'success'
  if (['running', 'triaged', 'ticket_created'].includes(status)) return 'info'
  if (['planned', 'waiting_review', 'paused', 'queued', 'pending', 'warning'].includes(status)) return 'warning'
  if (['failed', 'timeout', 'cancelled'].includes(status)) return 'danger'
  if (['new', 'draft'].includes(status)) return 'neutral'
  return 'neutral'
}

export const labelOf = (status: string | null | undefined): string => (status ? STATUS_LABELS[status] ?? status : '—')

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const date = typeof value === 'string' ? new Date(value) : value
  const diff = Date.now() - date.getTime()
  if (Number.isNaN(diff)) return '—'
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return formatDate(date)
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '0'
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function formatCost(value: number | null | undefined): string {
  if (!value) return '$0.00'
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`
}

export const shortId = (id: string | null | undefined): string => (id ? id.replace(/-/g, '').slice(0, 8) : '—')

export function initials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const first = trimmed[0] ?? '?'
  return /[\u4e00-\u9fa5]/.test(first) ? first : trimmed.slice(0, 2).toUpperCase()
}

export function percent(part: number, total: number): number {
  if (!total) return 0
  return Math.round((part / total) * 100)
}
