import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, ApiError, type ProjectSummary } from '../api'
import { Badge, Button, Card, EmptyState, ErrorNotice, ErrorState, Field, PageHeader, Spinner, useAsync, useToast } from '../components'
import { ROLE_LABELS, formatDate, relativeTime } from '../format'

function ProjectCard({ project }: { project: ProjectSummary }) {
  return (
    <article className="project-card">
      <div className="project-card__head">
        <div className="project-card__title">
          <Link to={`/projects/${project.id}`}>{project.name}</Link>
          <span>{project.slug}</span>
        </div>
        <Badge status={project.status} label={project.status === 'draft' ? '草稿' : project.status === 'active' ? '运行中' : project.status === 'paused' ? '已暂停' : '已归档'} />
      </div>
      <div className="project-card__meta">
        <div className="meta-line">
          <span className="meta-icon" aria-hidden>⌥</span>
          <span>{project.repo ? project.repo.fullName : '尚未绑定仓库'}</span>
        </div>
        <div className="meta-line">
          <span className="meta-icon" aria-hidden>◈</span>
          <span>
            {project.channel
              ? `${project.channel.provider === 'feishu' ? '飞书' : '企业微信'} · ${project.channel.name ?? project.channel.externalChatId}`
              : '尚未绑定 IM 群'}
          </span>
        </div>
      </div>
      <div className="project-card__stats">
        <span>
          <strong>{project.openTickets}</strong> 活跃工单
        </span>
        <span>
          <strong>{project.memberCount}</strong> 成员
        </span>
        <span>
          <strong>{project.role ? ROLE_LABELS[project.role] : '—'}</strong>
        </span>
        <span style={{ marginLeft: 'auto' }}>{relativeTime(project.updatedAt)}更新</span>
      </div>
    </article>
  )
}

export function ProjectsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { notify } = useToast()
  const state = useAsync(() => api.projects.list(), [])
  const [modalOpen, setModalOpen] = useState(searchParams.get('new') === '1')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const closeModal = () => {
    setModalOpen(false)
    setError(null)
    if (searchParams.get('new')) {
      searchParams.delete('new')
      setSearchParams(searchParams, { replace: true })
    }
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.projects.create({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) })
      notify('项目已创建，请继续绑定仓库与 IM 群', 'success')
      window.dispatchEvent(new Event('projects:changed'))
      closeModal()
      navigate(`/projects/${result.project.id}`)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="项目"
        subtitle="一个项目 = 一个 GitHub 仓库 + 一组成员 + 一套策略 + 一个 IM 群。"
        actions={
          <Button variant="primary" onClick={() => setModalOpen(true)}>
            ＋ 新建项目
          </Button>
        }
      />

      {state.loading ? <Card><Spinner label="正在加载项目…" /></Card> : null}
      {state.error ? (
        <Card>
          <ErrorState message={state.error} onRetry={state.reload} />
        </Card>
      ) : null}
      {!state.loading && !state.error && state.data?.items.length === 0 ? (
        <Card>
          <EmptyState
            title="还没有项目"
            hint="创建项目后，绑定仓库与群，生成邀请二维码即可邀请成员。"
            action={
              <Button variant="primary" onClick={() => setModalOpen(true)}>
                创建第一个项目
              </Button>
            }
          />
        </Card>
      ) : null}

      {!state.loading && !state.error && (state.data?.items.length ?? 0) > 0 ? (
        <>
          <div className="project-grid">
            {state.data?.items.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 18 }}>
            共 {state.data?.items.length} 个项目 · 最近更新 {formatDate(state.data?.items[0]?.updatedAt)}
          </p>
        </>
      ) : null}

      {modalOpen ? (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeModal()}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
            <header className="modal__head">
              <h2 id="new-project-title">新建项目</h2>
              <button className="icon-btn" onClick={closeModal} aria-label="关闭">
                ×
              </button>
            </header>
            <div className="modal__body">
              <div className="form-stack">
                <Field label="项目名称" hint="创建后可在设置中修改。">
                  <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：增长实验平台" maxLength={80} autoFocus />
                </Field>
                <Field label="项目说明（可选）">
                  <textarea className="textarea" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这个项目负责什么？" maxLength={2000} />
                </Field>
                <ErrorNotice message={error} />
                <p className="small muted">创建后状态为草稿，绑定仓库和群后才能启用接单。</p>
              </div>
            </div>
            <footer className="modal__foot">
              <Button onClick={closeModal} disabled={busy}>
                取消
              </Button>
              <Button variant="primary" onClick={create} loading={busy} disabled={!name.trim()}>
                创建项目
              </Button>
            </footer>
          </div>
        </div>
      ) : null}
    </>
  )
}
