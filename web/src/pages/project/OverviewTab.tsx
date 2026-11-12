import { Link } from 'react-router-dom'
import { api } from '../../api'
import { Badge, Button, Card, EmptyState, ErrorState, Spinner, StatCard, useAsync } from '../../components'
import { formatNumber, labelOf, relativeTime } from '../../format'
import type { ProjectTabProps } from './types'
import { policyLabel } from './types'
import { WecomJoinCard } from './WecomJoinCard'

export function OverviewTab({ project, role, refresh, onNavigate }: ProjectTabProps) {
  const state = useAsync(() => api.projects.overview(project.id), [project.id])
  if (state.loading) {
    return (
      <Card>
        <Spinner label="正在加载概览…" />
      </Card>
    )
  }
  if (state.error || !state.data) {
    return (
      <Card>
        <ErrorState message={state.error ?? '概览加载失败'} onRetry={state.reload} />
      </Card>
    )
  }
  const data = state.data
  const channelConfig = project.channel?.config ?? {}
  const groupLink =
    typeof channelConfig.joinUrl === 'string'
      ? channelConfig.joinUrl
      : project.channel?.provider === 'feishu'
        ? `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(project.channel.externalChatId)}`
        : ''
  const activeTickets =
    (data.tickets.new ?? 0) + (data.tickets.triaged ?? 0) + (data.tickets.planned ?? 0) + (data.tickets.running ?? 0) + (data.tickets.waiting_review ?? 0)
  const budget = data.policy.dailyTokenBudget
  const budgetHint = budget > 0 ? `预算 ${formatNumber(budget)} / 天` : '未设置预算'

  return (
    <div className="stack">
      <div className="grid grid--stats">
        <StatCard label="活跃工单" value={activeTickets} hint={`共 ${formatNumber(Object.values(data.tickets).reduce((sum, value) => sum + value, 0))} 个工单`} />
        <StatCard label="执行中" value={data.runs.running ?? 0} hint={`排队 ${data.runs.queued ?? 0}`} tone={(data.runs.running ?? 0) > 0 ? 'warning' : undefined} />
        <StatCard label="待评审" value={data.tickets.waiting_review ?? 0} hint="PR 等待人工合并" />
        <StatCard label="今日 Token" value={formatNumber(data.todayTokens)} hint={budgetHint} tone={budget > 0 && data.todayTokens >= budget ? 'danger' : undefined} />
      </div>

      <WecomJoinCard project={project} role={role} refresh={refresh} onNavigate={onNavigate} />

      <div className="grid grid--2">
        <Card
          title="交付配置"
          extra={<Button size="sm" variant="subtle" onClick={() => onNavigate('settings')}>策略设置</Button>}
        >
          <div className="readiness">
            <button
              className="readiness__item"
              onClick={() => onNavigate('repo')}
              style={{ textAlign: 'left', cursor: 'pointer' }}
            >
              <span className="readiness__check" data-ok={String(Boolean(project.repo))}>
                {project.repo ? '✓' : '–'}
              </span>
              <span className="readiness__text">
                <strong>GitHub 仓库</strong>
                <span>{project.repo ? project.repo.fullName : '点击绑定仓库'}</span>
              </span>
            </button>
            <button
              className="readiness__item"
              onClick={() => onNavigate('channel')}
              style={{ textAlign: 'left', cursor: 'pointer' }}
            >
              <span className="readiness__check" data-ok={String(Boolean(project.channel))}>
                {project.channel ? '✓' : '–'}
              </span>
              <span className="readiness__text">
                <strong>IM 群</strong>
                <span>
                  {project.channel
                    ? `${project.channel.provider === 'feishu' ? '飞书' : '企业微信'} · ${project.channel.name ?? project.channel.externalChatId}`
                    : '点击绑定已有群'}
                </span>
              </span>
            </button>
            <div className="readiness__item">
              <span className="readiness__check" data-ok="true">✓</span>
              <span className="readiness__text">
                <strong>成员</strong>
                <span>{project.memberCount} 人 · 点击「邀请」生成二维码</span>
              </span>
            </div>
            <div className="readiness__item">
              <span className="readiness__check" data-ok={String(data.policy.planApproval === 'required')}>
                {data.policy.planApproval === 'required' ? '✓' : '–'}
              </span>
              <span className="readiness__text">
                <strong>计划审批</strong>
                <span>{policyLabel(data.policy.planApproval)} · 并发 {data.policy.maxConcurrentRuns}</span>
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 14 }}>
            <Badge tone={data.policy.allowThreadReplies ? 'success' : 'neutral'} label={data.policy.allowThreadReplies ? '线程回复免 @' : '线程需 @bot'} />
            <Badge tone={data.policy.retryOnFailure ? 'info' : 'neutral'} label={data.policy.retryOnFailure ? '失败自动重试一次' : '失败不重试'} />
            <Badge tone="brand" label={`单次超时 ${data.policy.maxRunMinutes} 分钟`} />
            <Badge tone="neutral" label="PR 不自动合并" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {groupLink ? (
              <a className="btn btn--sm" href={groupLink} target="_blank" rel="noreferrer">
                打开项目群 ↗
              </a>
            ) : null}
            <span className="small muted">群二维码 / 邀请链接在「IM 群」配置，新成员接受邀请后会看到入群入口。</span>
          </div>
        </Card>

        <Card title="活跃 Turn" extra={<Button size="sm" variant="subtle" onClick={() => onNavigate('tickets')}>全部工单</Button>}>
          {data.activeRuns.length === 0 ? (
            <EmptyState title="当前没有运行中的任务" hint="成员在群里 @bot 提需求后，这里会显示排队与执行进度。" />
          ) : (
            <div className="run-list">
              {data.activeRuns.map((run) => (
                <div className="run-card" key={run.id}>
                  <div className="run-card__head">
                    <div className="run-card__id">
                      <Badge status={run.status} />
                      <span>{run.kind === 'plan' ? '计划' : '执行'}</span>
                      <code>{run.id.slice(0, 8)}</code>
                    </div>
                    <span className="small muted">{relativeTime(run.startedAt ?? run.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="最近工单"
        extra={<Button size="sm" variant="subtle" onClick={() => onNavigate('tickets')}>查看全部</Button>}
        className="grid"
      >
        {data.recentTickets.length === 0 ? (
          <EmptyState title="还没有工单" hint="在项目群里 @bot 描述需求，或在「工单」页手动建单。" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>工单</th>
                  <th>状态</th>
                  <th>提交人</th>
                  <th>更新时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.recentTickets.map((ticket) => (
                  <tr key={ticket.id}>
                    <td>
                      <div className="table__title">
                        <Link className="row-link" to={`/projects/${project.id}/tickets/${ticket.id}`}>
                          {ticket.title}
                        </Link>
                        <span>
                          #{ticket.id.replace(/-/g, '').slice(0, 8)} · {labelOf(ticket.stage ?? ticket.status)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <Badge status={ticket.stage ?? ticket.status} label={labelOf(ticket.stage ?? ticket.status)} />
                    </td>
                    <td>{ticket.requesterName ?? '—'}</td>
                    <td className="small muted">{relativeTime(ticket.updatedAt)}</td>
                    <td className="table__actions">
                      <Link className="btn btn--subtle btn--sm" to={`/projects/${project.id}/tickets/${ticket.id}`}>
                        查看
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid--3">
        <StatCard label="已完成" value={data.tickets.done ?? 0} hint="PR 合并后自动关闭" tone="success" />
        <StatCard label="失败 / 取消" value={(data.tickets.failed ?? 0) + (data.tickets.cancelled ?? 0)} hint="可在工单页重试" tone={(data.tickets.failed ?? 0) > 0 ? 'danger' : undefined} />
        <StatCard label="累计 Turn" value={Object.values(data.runs).reduce((sum, value) => sum + value, 0)} hint={`失败 ${data.runs.failed ?? 0} · 超时 ${data.runs.timeout ?? 0}`} />
      </div>
    </div>
  )
}
