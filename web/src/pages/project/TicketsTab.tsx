import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError } from '../../api'
import { Badge, Button, Card, EmptyState, ErrorNotice, ErrorState, Field, Modal, Spinner, useAsync, useToast } from '../../components'
import { labelOf, relativeTime } from '../../format'
import type { ProjectTabProps } from './types'

export function TicketsTab({ project, role }: ProjectTabProps) {
  const navigate = useNavigate()
  const { notify } = useToast()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [priority, setPriority] = useState('normal')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const state = useAsync(
    () =>
      api.tickets.list(project.id, {
        ...(status ? { status } : {}),
        ...(query ? { q: query } : {}),
        limit: 20,
        offset: page * 20,
      }),
    [project.id, status, query, page],
  )

  const canCreate =
    role !== 'viewer' && project.status === 'active' && !(role === 'member' && !project.policyJson.membersCanCreateTickets)

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.tickets.create(project.id, {
        ...(title.trim() ? { title: title.trim() } : {}),
        body: body.trim(),
        priority,
      })
      notify(result.warning ? `工单已创建，但未能排队：${result.warning}` : '工单已创建', result.warning ? 'danger' : 'success')
      setModalOpen(false)
      setTitle('')
      setBody('')
      navigate(`/projects/${project.id}/tickets/${result.ticket.id}`)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  const items = state.data?.items ?? []
  const total = state.data?.total ?? 0
  const pageCount = Math.max(Math.ceil(total / 20), 1)

  return (
    <>
      <div className="filters">
        <select className="select" value={status} onChange={(event) => { setStatus(event.target.value); setPage(0) }}>
          <option value="">全部状态</option>
          {['new', 'triaged', 'planned', 'running', 'waiting_review', 'done', 'failed', 'cancelled'].map((value) => (
            <option key={value} value={value}>
              {labelOf(value)}
            </option>
          ))}
        </select>
        <input
          className="input"
          placeholder="搜索标题"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              setQuery(search.trim())
              setPage(0)
            }
          }}
        />
        <Button
          size="sm"
          onClick={() => {
            setQuery(search.trim())
            setPage(0)
          }}
        >
          搜索
        </Button>
        <div className="filters__spacer" />
        <Button variant="primary" size="sm" onClick={() => setModalOpen(true)} disabled={!canCreate} title={canCreate ? '' : project.status !== 'active' ? '项目未启用' : '当前角色不能建单'}>
          ＋ 新建工单
        </Button>
      </div>

      <Card>
        {state.loading ? <Spinner label="正在加载工单…" /> : null}
        {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !state.error && items.length === 0 ? (
          <EmptyState
            title="没有符合条件的工单"
            hint={canCreate ? '可以在群里 @bot，或点击右上角手动建单。' : '暂无工单。'}
            action={canCreate ? <Button variant="primary" size="sm" onClick={() => setModalOpen(true)}>新建工单</Button> : undefined}
          />
        ) : null}
        {items.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>工单</th>
                    <th>状态</th>
                    <th>优先级</th>
                    <th>提交人</th>
                    <th>更新时间</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((ticket) => (
                    <tr key={ticket.id}>
                      <td>
                        <div className="table__title">
                          <Link className="row-link" to={`/projects/${project.id}/tickets/${ticket.id}`}>
                            {ticket.title}
                          </Link>
                          <span>
                            #{ticket.id.replace(/-/g, '').slice(0, 8)}
                            {ticket.prUrl ? ' · 已开 PR' : ''}
                          </span>
                        </div>
                      </td>
                      <td>
                        <Badge status={ticket.status} label={labelOf(ticket.status)} />
                      </td>
                      <td className="small muted">{ticket.priority}</td>
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
            <div className="pagination">
              <span>
                共 {total} 个工单 · 第 {page + 1} / {pageCount} 页
              </span>
              <div className="pagination__buttons">
                <Button size="sm" disabled={page === 0} onClick={() => setPage((value) => Math.max(value - 1, 0))}>
                  上一页
                </Button>
                <Button size="sm" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)}>
                  下一页
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </Card>

      <Modal
        open={modalOpen}
        title="新建工单"
        onClose={() => !busy && setModalOpen(false)}
        footer={
          <>
            <Button onClick={() => setModalOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" onClick={create} loading={busy} disabled={!body.trim()}>
              创建并排队
            </Button>
          </>
        }
      >
        <div className="form-stack">
          <Field label="标题（可选）" hint="留空时取正文第一行。">
            <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} placeholder="例如：登录页报错文案改成中文" />
          </Field>
          <Field label="需求描述" hint="描述越具体，计划与实现越准确。">
            <textarea className="textarea" value={body} onChange={(event) => setBody(event.target.value)} maxLength={20000} placeholder="要解决什么问题？验收标准是什么？" autoFocus />
          </Field>
          <Field label="优先级">
            <select className="select" value={priority} onChange={(event) => setPriority(event.target.value)}>
              <option value="low">低</option>
              <option value="normal">普通</option>
              <option value="high">高</option>
              <option value="urgent">紧急</option>
            </select>
          </Field>
          <ErrorNotice message={error} />
          {!canCreate ? <div className="notice notice--warning">当前项目状态或你的角色不允许新建工单。</div> : null}
        </div>
      </Modal>
    </>
  )
}
