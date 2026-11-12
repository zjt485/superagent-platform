import { api, type MainSessionView } from '../../api'
import { Badge, Card, EmptyState, ErrorState, Spinner, useAsync } from '../../components'
import { formatDate, labelOf, relativeTime } from '../../format'
import type { ProjectTabProps } from './types'

function decisionSummary(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          const decision = item as { action?: string; triggerId?: string; reason?: string; ticket?: { title?: string } }
          return `${decision.action ?? 'decision'}${decision.ticket?.title ? `：${decision.ticket.title}` : ''}${decision.reason ? `（${decision.reason}）` : ''}`
        })
        .join('\n')
    }
    return JSON.stringify(parsed, null, 2)
  } catch {
    return content
  }
}

export function MainSessionTab({ project }: ProjectTabProps) {
  const state = useAsync<MainSessionView>(() => api.projects.mainSession(project.id), [project.id])
  if (state.loading) {
    return (
      <Card>
        <Spinner label="正在加载 Main Session…" />
      </Card>
    )
  }
  if (state.error || !state.data) {
    return (
      <Card>
        <ErrorState message={state.error ?? 'Main Session 加载失败'} onRetry={state.reload} />
      </Card>
    )
  }
  const data = state.data
  return (
    <div className="stack">
      <Card
        title="Main Session"
        extra={
          data.session ? (
            <Badge status={data.session.status === 'idle' ? 'active' : data.session.status} label={data.session.status} />
          ) : (
            <Badge tone="neutral" label="尚未创建" />
          )
        }
      >
        <div className="notice notice--info" style={{ marginBottom: 14 }}>
          Main Session 是每个项目唯一的持久路由 Agent：接收 Trigger、做 Eval/Decision，创建工单与 Mandate，再把工作交给每张工单自己的 Executor Session。
        </div>
        {!data.session ? (
          <EmptyState
            title="还没有 Main Session"
            hint="在群内 @bot 或在控制台创建工单后，平台会创建 Main Session 并保留其会话历史。"
          />
        ) : (
          <dl className="kv-list">
            <div>
              <dt>Session ID</dt>
              <dd>
                <code className="mono">{data.session.id}</code>
              </dd>
            </div>
            <div>
              <dt>模型 / Preset</dt>
              <dd>
                {data.session.model ?? '—'} · <code className="mono">{data.session.preset ?? '—'}</code>
              </dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>{data.session.status}</dd>
            </div>
            <div>
              <dt>最近活动</dt>
              <dd>{relativeTime(data.session.lastTurnAt ?? data.session.createdAt)}</dd>
            </div>
          </dl>
        )}
      </Card>

      {data.session ? (
        <Card title="会话记录" extra={<span className="small muted">最近 {data.transcript.length} 条</span>}>
          {data.transcript.length === 0 ? (
            <EmptyState title="还没有会话记录" hint="下一次 Eval 会带着之前的决策历史进入 Main Session。" />
          ) : (
            <div className="message-list">
              {data.transcript.map((message, index) => (
                <div className="message" key={`${message.role}-${index}`}>
                  <div className="message__head">
                    <span>{message.role === 'assistant' ? 'Main Session 决策' : '输入'}</span>
                    <span>{data.session?.lastTurnAt ? formatDate(data.session.lastTurnAt) : ''}</span>
                  </div>
                  <div className="message__text" style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                    {message.role === 'assistant' ? decisionSummary(message.content) : message.content}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : null}

      {data.turns.length > 0 ? (
        <Card title="Main Session Turns" extra={<span className="small muted">最近 {data.turns.length} 次</span>}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Turn</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>耗时</th>
                  <th>Token</th>
                </tr>
              </thead>
              <tbody>
                {data.turns.map((turn) => (
                  <tr key={turn.id}>
                    <td>
                      <code className="mono">{turn.id.slice(0, 8)}</code>
                    </td>
                    <td>{turn.kind === 'plan' ? 'eval' : turn.kind === 'execute' ? 'execute' : turn.kind}</td>
                    <td>
                      <Badge status={turn.status} label={labelOf(turn.status)} />
                    </td>
                    <td className="small muted">
                      {turn.startedAt && turn.endedAt
                        ? `${Math.max(Math.round((new Date(turn.endedAt).getTime() - new Date(turn.startedAt).getTime()) / 1000), 0)}s`
                        : '—'}
                    </td>
                    <td>{turn.tokens}</td>
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
