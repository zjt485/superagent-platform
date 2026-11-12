import { api } from '../../api'
import { Card, EmptyState, ErrorState, Spinner, StatCard, useAsync } from '../../components'
import { formatCost, formatNumber } from '../../format'
import type { ProjectTabProps } from './types'

export function UsageTab({ project }: ProjectTabProps) {
  const state = useAsync(() => api.projects.usage(project.id, 30), [project.id])
  if (state.loading) {
    return (
      <Card>
        <Spinner label="正在加载用量…" />
      </Card>
    )
  }
  if (state.error || !state.data) {
    return (
      <Card>
        <ErrorState message={state.error ?? '用量加载失败'} onRetry={state.reload} />
      </Card>
    )
  }
  const series = [...state.data.series].sort((a, b) => a.day.localeCompare(b.day))
  const totals = series.reduce(
    (sum, day) => ({ runs: sum.runs + day.runs, tokens: sum.tokens + day.tokens, cost: sum.cost + day.cost }),
    { runs: 0, tokens: 0, cost: 0 },
  )
  const max = Math.max(...series.map((day) => day.tokens), 1)
  const budget = state.data.policy.dailyTokenBudget

  return (
    <div className="stack">
      <div className="grid grid--stats">
        <StatCard label="今日 Token" value={formatNumber(state.data.todayTokens)} hint={budget > 0 ? `预算 ${formatNumber(budget)}` : '未设置预算'} tone={budget > 0 && state.data.todayTokens >= budget ? 'danger' : undefined} />
        <StatCard label="近 30 天运行" value={formatNumber(totals.runs)} hint="计划与执行合计" />
        <StatCard label="近 30 天 Token" value={formatNumber(totals.tokens)} />
        <StatCard label="近 30 天成本" value={formatCost(totals.cost)} hint="按 Runtime 上报的估算值" />
      </div>

      <Card title="Token 消耗趋势" extra={<span className="small muted">最近 {series.length} 天</span>}>
        {series.length === 0 ? (
          <EmptyState title="还没有用量数据" hint="运行工单后，这里会按天统计 Token 与成本。" />
        ) : (
          <>
            <div className="bar-chart" role="img" aria-label="每日 token 消耗柱状图">
              {series.map((day) => (
                <div className="bar" key={day.day} title={`${day.day}：${formatNumber(day.tokens)} tokens / ${day.runs} runs`}>
                  <div className="bar__fill" style={{ height: `${Math.max((day.tokens / max) * 100, 2)}%` }} />
                  <span className="bar__label">{day.day.slice(5)}</span>
                </div>
              ))}
            </div>
            {budget > 0 ? (
              <div style={{ marginTop: 14 }}>
                <div className="pagination" style={{ padding: 0, border: 'none' }}>
                  <span>今日预算使用</span>
                  <span>
                    {formatNumber(state.data.todayTokens)} / {formatNumber(budget)} · {Math.min(Math.round((state.data.todayTokens / budget) * 100), 999)}%
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min((state.data.todayTokens / budget) * 100, 100)}%`,
                      background: state.data.todayTokens >= budget ? 'var(--danger)' : 'var(--brand)',
                    }}
                  />
                </div>
              </div>
            ) : null}
          </>
        )}
      </Card>

      {series.length > 0 ? (
        <Card title="每日明细">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>运行数</th>
                  <th>Token</th>
                  <th>成本</th>
                </tr>
              </thead>
              <tbody>
                {[...series].reverse().map((day) => (
                  <tr key={day.day}>
                    <td className="mono">{day.day}</td>
                    <td>{day.runs}</td>
                    <td>{formatNumber(day.tokens)}</td>
                    <td>{formatCost(day.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  )
}
