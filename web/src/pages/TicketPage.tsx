import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError, type MemberRole, type Run, type TicketDetail } from '../api'
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  EmptyState,
  ErrorNotice,
  ErrorState,
  Spinner,
  useAsync,
  useToast,
} from '../components'
import { ROLE_LABELS, formatCost, formatDate, formatNumber, labelOf, relativeTime, shortId } from '../format'

const ACTIVE_STATUSES = ['new', 'triaged', 'planned', 'running', 'waiting_review']
const INTAKE_LABELS: Record<string, string> = {
  ticket_created: '创建工单',
  ticket_appended: '追加到工单',
  command: '执行命令',
  ignored: '忽略消息',
  duplicate: '重复消息',
}

function RunItem({ run, onRefresh }: { run: Run; onRefresh: () => void }) {
  const [open, setOpen] = useState(false)
  const events = useAsync(() => (open ? api.runs.get(run.id).then((result) => result.events) : Promise.resolve([])), [open, run.id])
  const duration =
    run.startedAt && run.endedAt
      ? `${Math.max(Math.round((new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) / 1000), 0)}s`
      : run.startedAt
        ? '进行中'
        : '—'

  return (
    <div className="run-card">
      <div className="run-card__head">
        <div className="run-card__id">
          <Badge status={run.status} label={labelOf(run.status)} />
          <span>{run.kind === 'plan' ? '计划' : '执行'}</span>
          <code>#{shortId(run.id)}</code>
          {run.attempt > 1 ? <span className="small muted">第 {run.attempt} 次</span> : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="small muted">
            {duration} · {formatNumber(run.tokens)} tokens · {formatCost(run.cost)}
          </span>
          <Button
            size="sm"
            variant="subtle"
            onClick={() => {
              setOpen((value) => !value)
              if (!open) onRefresh()
            }}
          >
            {open ? '收起日志' : '查看日志'}
          </Button>
        </div>
      </div>
      {run.error ? (
        <div className="run-card__body">
          <div className="notice notice--danger">{run.error}</div>
        </div>
      ) : null}
      {open ? (
        <div className="run-card__body">
          {events.loading ? <Spinner label="加载日志…" /> : null}
          {events.error ? <ErrorNotice message={events.error} /> : null}
          {!events.loading && (events.data?.length ?? 0) === 0 ? <p className="small muted">这个 Run 还没有回传事件。</p> : null}
          {events.data && events.data.length > 0 ? (
            <div className="log-panel">
              {events.data.map((event) => (
                <div className="log-line" key={event.id} data-type={event.type}>
                  <span className="log-line__type">{event.type}</span>
                  <span>{event.message ?? ''}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function TicketPage() {
  const { projectId, ticketId } = useParams<{ projectId: string; ticketId: string }>()
  const { notify } = useToast()
  const [error, setError] = useState<string | null>(null)
  const state = useAsync(async () => {
    const [detail, project] = await Promise.all([api.tickets.detail(projectId ?? '', ticketId ?? ''), api.projects.get(projectId ?? '')])
    return { detail, role: project.project.role }
  }, [projectId, ticketId])

  const status = state.data?.detail.ticket.status
  useEffect(() => {
    if (!status || !ACTIVE_STATUSES.includes(status)) return
    const timer = window.setInterval(() => state.reload(), 5000)
    return () => window.clearInterval(timer)
  }, [status, state.reload])

  if (state.loading && !state.data) {
    return (
      <div className="full-page-center" style={{ minHeight: 260 }}>
        <Spinner label="正在加载工单…" />
      </div>
    )
  }
  if (state.error || !state.data) {
    return <ErrorState message={state.error ?? '工单不存在'} onRetry={state.reload} />
  }

  const detail: TicketDetail = state.data.detail
  const role: MemberRole = state.data.role
  const canMaintain = role === 'owner' || role === 'maintainer'
  const ticket = detail.ticket
  const active = ACTIVE_STATUSES.includes(ticket.status)

  const act = async (action: 'approve' | 'cancel' | 'retry') => {
    setError(null)
    try {
      if (action === 'approve') await api.tickets.approve(projectId ?? '', ticket.id)
      if (action === 'cancel') await api.tickets.cancel(projectId ?? '', ticket.id)
      if (action === 'retry') await api.tickets.retry(projectId ?? '', ticket.id)
      notify(action === 'approve' ? '已批准计划并开始执行' : action === 'cancel' ? '工单已取消' : '已重新排队', 'success')
      state.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '操作失败')
    }
  }

  return (
    <>
      <p className="small muted" style={{ marginBottom: 12 }}>
        <Link to={`/projects/${projectId}?tab=tickets`}>← 返回工单列表</Link>
      </p>

      <section className="ticket-hero">
        <div className="ticket-hero__top">
          <div>
            <div className="ticket-meta">
              <code className="mono">#{shortId(ticket.id)}</code>
              <Badge status={ticket.status} label={labelOf(ticket.status)} />
              <span>优先级 {ticket.priority}</span>
              <span>创建于 {formatDate(ticket.createdAt)}</span>
            </div>
            <h1 style={{ marginTop: 8 }}>{ticket.title}</h1>
            <div className="ticket-meta" style={{ marginTop: 8 }}>
              <span>提交人 {ticket.requesterName ?? '—'}</span>
              {ticket.branch ? (
                <span>
                  分支 <code className="mono">{ticket.branch}</code>
                </span>
              ) : null}
              {ticket.prUrl ? (
                <a href={ticket.prUrl} target="_blank" rel="noreferrer">
                  打开 PR ↗
                </a>
              ) : null}
              <span>更新于 {relativeTime(ticket.updatedAt)}</span>
            </div>
          </div>
          <div className="page-header__actions">
            <Button size="sm" variant="subtle" onClick={state.reload}>
              刷新
            </Button>
            {canMaintain && ticket.status === 'planned' ? (
              <Button size="sm" variant="primary" onClick={() => void act('approve')}>
                批准计划并执行
              </Button>
            ) : null}
            {canMaintain && (ticket.status === 'failed' || ticket.status === 'cancelled') ? (
              <Button size="sm" variant="primary" onClick={() => void act('retry')}>
                重试
              </Button>
            ) : null}
            {canMaintain && active ? (
              <ConfirmButton
                size="sm"
                variant="danger"
                title="取消工单"
                message="取消后运行中的 Agent 会被终止，排队的 Run 会被取消。"
                confirmLabel="取消工单"
                danger
                onConfirm={() => act('cancel')}
              >
                取消
              </ConfirmButton>
            ) : null}
          </div>
        </div>
        <ErrorNotice message={error} />
        {!canMaintain ? (
          <p className="small muted">
            当前角色 {ROLE_LABELS[role] ?? role}：可以查看工单与运行日志；审批、取消、重试需要 Maintainer 及以上。
          </p>
        ) : null}
      </section>

      <div className="split" style={{ marginTop: 16 }}>
        <div className="stack">
          <Card title="需求">
            <div className="ticket-body">{ticket.body}</div>
          </Card>

          {ticket.plan ? (
            <Card title="执行计划" extra={ticket.planApprovedAt ? <Badge tone="success" label="已批准" /> : <Badge tone="warning" label="待批准" />}>
              <div className="plan-box">{ticket.plan}</div>
            </Card>
          ) : null}

          <Card
            title="运行记录"
            extra={
              <span className="small muted">
                {detail.runs.length} 次运行 · {detail.runs.filter((run) => run.status === 'succeeded').length} 成功
              </span>
            }
          >
            {detail.runs.length === 0 ? (
              <EmptyState title="还没有运行记录" hint="工单入队后，Worker 领取任务会在这里显示计划与执行。" />
            ) : (
              <div className="run-list">
                {detail.runs.map((run) => (
                  <RunItem key={run.id} run={run} onRefresh={state.reload} />
                ))}
              </div>
            )}
          </Card>

          {detail.messages.length > 0 ? (
            <Card title="线程消息" extra={<span className="small muted">最近 {detail.messages.length} 条</span>}>
              <div className="message-list">
                {detail.messages.map((message) => (
                  <div className="message" key={message.id}>
                    <div className="message__head">
                      <span>
                        {message.senderName ?? '成员'} · {message.provider}
                      </span>
                      <span>{formatDate(message.createdAt)}</span>
                    </div>
                    <div className="message__text">{message.text}</div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>

        <div className="stack">
          <Card title="工单信息">
            <dl className="kv-list">
              <div>
                <dt>工单号</dt>
                <dd>
                  <code className="mono">{ticket.id}</code>
                </dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>
                  <Badge status={ticket.status} label={labelOf(ticket.status)} />
                </dd>
              </div>
              <div>
                <dt>提交人</dt>
                <dd>{ticket.requesterName ?? '—'}</dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{formatDate(ticket.createdAt)}</dd>
              </div>
              <div>
                <dt>更新时间</dt>
                <dd>{formatDate(ticket.updatedAt)}</dd>
              </div>
              {ticket.planApprovedAt ? (
                <div>
                  <dt>计划批准</dt>
                  <dd>{formatDate(ticket.planApprovedAt)}</dd>
                </div>
              ) : null}
              {ticket.closedAt ? (
                <div>
                  <dt>关闭时间</dt>
                  <dd>{formatDate(ticket.closedAt)}</dd>
                </div>
              ) : null}
              {ticket.prUrl ? (
                <div>
                  <dt>Pull Request</dt>
                  <dd>
                    <a href={ticket.prUrl} target="_blank" rel="noreferrer">
                      {ticket.prUrl}
                    </a>
                  </dd>
                </div>
              ) : null}
            </dl>
          </Card>

          <Card title="审批与判定">
            {detail.approvals.length === 0 && detail.intake.length === 0 ? (
              <EmptyState title="暂无审批记录" />
            ) : (
              <div className="timeline">
                {detail.approvals.map((approval) => (
                  <div className="timeline__item" key={approval.id}>
                    <span className="timeline__dot" data-tone={approval.decision === 'approved' ? 'success' : 'danger'} />
                    <div className="timeline__content">
                      <strong>{approval.kind === 'plan' ? '计划审批' : '合并审批'} · {approval.decision === 'approved' ? '批准' : '拒绝'}</strong>
                      <span>{formatDate(approval.createdAt)}</span>
                      {approval.comment ? <p>{approval.comment}</p> : null}
                    </div>
                  </div>
                ))}
                {detail.intake.map((event) => (
                  <div className="timeline__item" key={event.id}>
                    <span className="timeline__dot" data-tone={event.action === 'ignored' ? 'warning' : 'info'} />
                    <div className="timeline__content">
                      <strong>{INTAKE_LABELS[event.action] ?? event.action}</strong>
                      <span>{formatDate(event.createdAt)}</span>
                      {event.reason || event.command ? <p>{event.command ? `/${event.command}` : ''} {event.reason ?? ''}</p> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="安全边界">
            <p className="small muted" style={{ lineHeight: 1.8 }}>
              Agent 在隔离工作目录中执行，只能推 <code className="mono">agent/*</code> 分支；PR 需要人工评审合并，平台不会自动合并。
              群消息与 PR 评论均按不可信输入处理。
            </p>
          </Card>
        </div>
      </div>
    </>
  )
}
