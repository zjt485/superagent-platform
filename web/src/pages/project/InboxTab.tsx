import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, subscribeProjectEvents, type ActionApproval } from '../../api'
import { Badge, Button, Card, EmptyState, ErrorNotice, Spinner, useAsync, useToast } from '../../components'
import { relativeTime } from '../../format'
import { canMaintain, type ProjectTabProps } from './types'

export function InboxTab({ project, role }: ProjectTabProps) {
  const { notify } = useToast()
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')
  const state = useAsync(
    () => api.approvals.list(project.id, filter === 'pending' ? 'pending' : undefined),
    [project.id, filter],
  )
  const [comments, setComments] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const unsub = subscribeProjectEvents(project.id, (event) => {
      if (event.type === 'approval.created' || event.type === 'approval.resolved') {
        state.reload()
      }
    })
    return unsub
  }, [project.id])

  const decide = async (
    approval: ActionApproval,
    decision: 'approved' | 'rejected' | 'revision_requested',
  ) => {
    setBusyId(approval.id)
    setError(null)
    try {
      await api.approvals.decide(project.id, approval.id, {
        decision,
        ...(comments[approval.id]?.trim() ? { comment: comments[approval.id]?.trim() } : {}),
      })
      notify(
        decision === 'approved'
          ? '已批准执行，Bot 正从断点继续'
          : decision === 'revision_requested'
            ? '已打回并附上修改意见'
            : '已拒绝该操作',
        'success',
      )
      state.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '审批操作失败')
    } finally {
      setBusyId(null)
    }
  }

  const items: ActionApproval[] = state.data?.items ?? []
  const editable = canMaintain(role)

  return (
    <div className="stack">
      <Card
        title="审批收件箱（Suggest, don't send）"
        extra={
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="sm" variant={filter === 'pending' ? 'primary' : 'subtle'} onClick={() => setFilter('pending')}>
              待我审批
            </Button>
            <Button size="sm" variant={filter === 'all' ? 'primary' : 'subtle'} onClick={() => setFilter('all')}>
              全部记录
            </Button>
          </div>
        }
      >
        <p className="small muted" style={{ marginBottom: 14 }}>
          当任意 Bot 准备执行高风险或受控工具调用（如敏感命令、对外发送、外部 MCP 写入）时，Turn 会自动暂停并保存上下文断点，等待你在此处或飞书交互卡片里拍板后继续。
        </p>
        <ErrorNotice message={error} />

        {state.loading ? (
          <Spinner label="加载审批单…" />
        ) : items.length === 0 ? (
          <EmptyState
            title={filter === 'pending' ? '当前没有待审批动作' : '还没有工具级审批记录'}
            hint="所有 Bot 处于低风险自主运行状态，需要人工确认时会第一时间推送到这里和 IM 卡片。"
          />
        ) : (
          <div className="stack">
            {items.map((item) => (
              <div key={item.id} className="bot-card">
                <div className="bot-card__head">
                  <div className="bot-card__avatar">{item.botAvatar ?? '🤖'}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong>{item.title}</strong>
                      <Badge
                        tone={item.riskLevel === 'high' ? 'danger' : 'warning'}
                        label={item.riskLevel === 'high' ? '高风险' : '中风险'}
                      />
                      <Badge
                        tone={
                          item.status === 'approved'
                            ? 'success'
                            : item.status === 'pending'
                              ? 'warning'
                              : 'danger'
                        }
                        label={
                          item.status === 'pending'
                            ? '待审批'
                            : item.status === 'approved'
                              ? '已批准'
                              : item.status === 'revision_requested'
                                ? '要求修改'
                                : '已拒绝'
                        }
                      />
                    </div>
                    <div className="small muted" style={{ marginTop: 2 }}>
                      {item.botName ? `${item.botName} (@${item.botSlug})` : 'Executor'} · 工具 <code>{item.toolName}</code> ·{' '}
                      <Link to={`/projects/${project.id}/tickets/${item.ticketId}`}>
                        #{item.ticketShortName ?? item.ticketId.slice(0, 8)} {item.ticketTitle}
                      </Link>{' '}
                      · {relativeTime(item.createdAt)}
                    </div>
                  </div>
                </div>

                <pre className="log-panel mono small" style={{ maxHeight: 180, overflow: 'auto', margin: 0 }}>
                  {JSON.stringify(item.preview, null, 2)}
                </pre>

                {item.status === 'pending' && editable ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      className="input"
                      style={{ flex: 1, minWidth: 220 }}
                      value={comments[item.id] ?? ''}
                      onChange={(e) => setComments((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      placeholder="可选：批注或打回修改意见…"
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      loading={busyId === item.id}
                      onClick={() => decide(item, 'approved')}
                    >
                      批准执行
                    </Button>
                    <Button
                      size="sm"
                      variant="subtle"
                      loading={busyId === item.id}
                      onClick={() => decide(item, 'revision_requested')}
                    >
                      打回修改
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busyId === item.id}
                      onClick={() => decide(item, 'rejected')}
                    >
                      拒绝
                    </Button>
                  </div>
                ) : item.decidedByName ? (
                  <div className="small muted">
                    已由 <strong>{item.decidedByName}</strong> 处理
                    {item.decisionComment ? `：${item.decisionComment}` : ''} · {item.decidedAt ? relativeTime(item.decidedAt) : ''}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
