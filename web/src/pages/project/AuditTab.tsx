import { useMemo, useState } from 'react'
import { api } from '../../api'
import { Badge, Button, Card, EmptyState, ErrorState, Spinner, useAsync } from '../../components'
import { formatDate, type Tone } from '../../format'
import type { ProjectTabProps } from './types'

const ACTION_LABELS: Record<string, string> = {
  'project.created': '创建项目',
  'project.updated': '更新项目',
  'project.status_changed': '项目状态变化',
  'member.added': '添加成员',
  'member.removed': '移除成员',
  'member.role_changed': '修改角色',
  'repo.bound': '绑定仓库',
  'repo.unbound': '解绑仓库',
  'channel.bound': '绑定群',
  'channel.unbound': '解绑群',
  'channel.bound_by_command': '群内 /bind 绑定',
  'invite.created': '生成邀请',
  'invite.revoked': '撤销邀请',
  'invite.accepted': '接受邀请',
  'ticket.created': '创建工单',
  'ticket.status_changed': '工单状态变化',
  'ticket.cancelled': '取消工单',
  'ticket.retried': '重试工单',
  'ticket.plan_approved': '批准计划',
  'ticket.plan_auto_approved': '自动批准计划',
  'ticket.approved_and_started': '批准并执行',
  'ticket.failed': '工单失败',
  'run.queued': 'Run 入队',
  'run.started': 'Run 开始',
  'run.succeeded': 'Run 成功',
  'run.failed': 'Run 失败',
  'run.timeout': 'Run 超时',
  'run.cancelled': 'Run 取消',
  'run.reaped': '回收失联 Run',
  'github.pr_opened': '创建 PR',
  'github.pr_merged': 'PR 已合并',
  'github.comment': 'PR 评论',
  'github.ci_status': 'CI 状态',
  'notification.sent': '通知已发送',
  'webhook.feishu': '飞书回调',
  'webhook.wecom': '企业微信回调',
  'webhook.duplicate': '重复回调',
  'webhook.duplicate_message': '重复消息',
}

export function AuditTab({ project }: ProjectTabProps) {
  const state = useAsync(() => api.projects.audit(project.id, 200), [project.id])
  const [filter, setFilter] = useState('')
  const items = useMemo(() => {
    const list = state.data?.items ?? []
    if (!filter.trim()) return list
    const needle = filter.trim().toLowerCase()
    return list.filter(
      (item) =>
        item.action.toLowerCase().includes(needle) ||
        (item.actorLabel ?? '').toLowerCase().includes(needle) ||
        (item.target ?? '').toLowerCase().includes(needle),
    )
  }, [state.data, filter])

  return (
    <div className="stack">
      <div className="filters">
        <input className="input" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="按动作 / 操作人 / 目标过滤" />
        <Button size="sm" variant="subtle" onClick={state.reload}>
          刷新
        </Button>
        <div className="filters__spacer" />
        <span className="small muted">最近 200 条 · 审计只追加不修改</span>
      </div>

      <Card>
        {state.loading ? <Spinner label="正在加载审计…" /> : null}
        {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !state.error && items.length === 0 ? <EmptyState title="没有审计记录" hint="项目操作、消息、工单、运行与审批都会记录在这里。" /> : null}
        {items.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>动作</th>
                  <th>操作人</th>
                  <th>目标</th>
                  <th>元数据</th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => {
                  const tone: Tone = entry.action.includes('failed') || entry.action.includes('cancelled') ? 'danger' : entry.action.includes('merged') || entry.action.includes('succeeded') ? 'success' : 'neutral'
                  return (
                    <tr key={entry.id}>
                      <td className="small muted nowrap">{formatDate(entry.createdAt)}</td>
                      <td>
                        <Badge tone={tone} label={ACTION_LABELS[entry.action] ?? entry.action} />
                        <div className="small muted mono" style={{ marginTop: 3 }}>
                          {entry.action}
                        </div>
                      </td>
                      <td>{entry.actorLabel ?? entry.actorId?.slice(0, 8) ?? '系统'}</td>
                      <td className="small mono" style={{ wordBreak: 'break-all', maxWidth: 240 }}>
                        {entry.target ?? '—'}
                      </td>
                      <td>
                        {entry.metadata ? (
                          <code className="mono" style={{ color: 'var(--muted)', fontSize: 10.5 }}>
                            {JSON.stringify(entry.metadata).slice(0, 120)}
                          </code>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <p className="small muted">审计可还原“谁在哪个群提了什么、Agent 做了什么、开了哪个 PR、谁批准了什么”。</p>
    </div>
  )
}
