import { useState } from 'react'
import { api, ApiError, type RepoCandidate } from '../../api'
import { Badge, Button, Card, ConfirmButton, EmptyState, ErrorNotice, ErrorState, Field, Spinner, useAsync, useToast } from '../../components'
import type { ProjectTabProps } from './types'
import { isOwner } from './types'

export function RepoTab({ project, role }: ProjectTabProps) {
  const owner = isOwner(role)
  const { notify } = useToast()
  const state = useAsync(() => api.repo.get(project.id), [project.id])
  const [candidates, setCandidates] = useState<RepoCandidate[] | null>(null)
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [mode, setMode] = useState<'app' | 'mock' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [installationId, setInstallationId] = useState('')
  const [repoOwner, setRepoOwner] = useState('')
  const [repoName, setRepoName] = useState('')
  const [branch, setBranch] = useState('main')

  const repo = state.data?.repo ?? null
  const installations = state.data?.installations ?? []

  const loadCandidates = async () => {
    setLoadingCandidates(true)
    setError(null)
    try {
      const result = await api.repo.candidates(project.id, installations[0]?.installationId)
      setCandidates(result.items)
      setMode(result.mode)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '无法加载仓库列表')
    } finally {
      setLoadingCandidates(false)
    }
  }

  const bindCandidate = async (candidate: RepoCandidate) => {
    setLoadingCandidates(true)
    setError(null)
    try {
      await api.repo.bind(project.id, {
        installationId: installations[0]?.installationId ?? '1',
        owner: candidate.owner,
        name: candidate.name,
        defaultBranch: candidate.defaultBranch,
      })
      notify(`已绑定 ${candidate.fullName}`, 'success')
      setCandidates(null)
      state.reload()
      window.dispatchEvent(new Event('projects:changed'))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '绑定失败')
    } finally {
      setLoadingCandidates(false)
    }
  }

  const bindManual = async () => {
    setError(null)
    try {
      await api.repo.bind(project.id, {
        installationId: installationId.trim(),
        owner: repoOwner.trim(),
        name: repoName.trim(),
        defaultBranch: branch.trim() || 'main',
      })
      notify('仓库已绑定', 'success')
      setFormOpen(false)
      state.reload()
      window.dispatchEvent(new Event('projects:changed'))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '绑定失败')
    }
  }

  return (
    <div className="stack">
      <Card
        title="GitHub 仓库"
        extra={
          <>
            <Badge tone={state.data?.mode === 'mock' ? 'warning' : 'neutral'} label={state.data?.mode === 'mock' ? 'Mock 模式' : 'GitHub App'} />
            {repo ? (
              <ConfirmButton
                title="解绑仓库"
                message="解绑后 Worker 无法克隆仓库，新工单不能执行。已创建的 PR 不受影响。"
                confirmLabel="解绑"
                danger
                size="sm"
                onConfirm={async () => {
                  try {
                    await api.repo.unbind(project.id)
                    notify('仓库已解绑', 'success')
                    state.reload()
                  } catch (cause) {
                    notify(cause instanceof ApiError ? cause.message : '解绑失败', 'danger')
                  }
                }}
              >
                解绑
              </ConfirmButton>
            ) : null}
          </>
        }
      >
        {state.loading ? <Spinner label="正在加载仓库…" /> : null}
        {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !repo ? (
          <EmptyState
            title="尚未绑定仓库"
            hint="每个项目绑定一个 GitHub 仓库；Agent 只允许推送到 agent/* 分支并创建 PR。"
            action={
              <Button variant="primary" size="sm" onClick={loadCandidates} loading={loadingCandidates}>
                选择仓库
              </Button>
            }
          />
        ) : null}
        {repo ? (
          <>
            <dl className="kv-list">
              <div>
                <dt>仓库</dt>
                <dd>
                  <strong>{repo.fullName}</strong>
                </dd>
              </div>
              <div>
                <dt>默认分支</dt>
                <dd>
                  <code className="mono">{repo.defaultBranch}</code>
                </dd>
              </div>
              <div>
                <dt>可见性</dt>
                <dd>{repo.private ? '私有' : '公开'}</dd>
              </div>
              <div>
                <dt>Installation</dt>
                <dd>
                  <code className="mono">{repo.installationId}</code>
                </dd>
              </div>
            </dl>
            <p className="small muted" style={{ marginTop: 12 }}>
              Agent 运行时会克隆该仓库、在 <code className="mono">agent/</code> 分支提交并创建 PR；默认不合并，需要人工评审。
            </p>
          </>
        ) : null}
      </Card>

      {!repo ? (
        <div className="grid grid--2">
          <Card title="绑定方式一：GitHub App 授权">
            <p className="small muted" style={{ lineHeight: 1.8 }}>
              安装 GitHub App 并授权仓库。安装回调会把 installation 记录到当前项目，然后可以从已授权仓库列表里选择。
            </p>
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              <a className="btn btn--primary btn--sm" href={api.repo.installUrl(project.id)}>
                安装 / 授权 GitHub App
              </a>
              <Button size="sm" onClick={loadCandidates} loading={loadingCandidates} disabled={!owner}>
                从已授权仓库选择
              </Button>
            </div>
            {mode === 'mock' || state.data?.mode === 'mock' ? (
              <div className="notice notice--warning" style={{ marginTop: 12 }}>
                当前是 Mock GitHub 模式：不会访问 GitHub。安装会模拟回调，仓库列表来自内置演示数据。
              </div>
            ) : null}
            {installations.length > 0 ? (
              <p className="small muted" style={{ marginTop: 10 }}>
                已记录 installation：{installations.map((item) => item.installationId).join('、')}
              </p>
            ) : null}
          </Card>

          <Card title="绑定方式二：手动填写">
            <div className="form-stack">
              {!formOpen ? (
                <Button variant="subtle" size="sm" onClick={() => setFormOpen(true)} disabled={!owner}>
                  手动填写 installation / 仓库
                </Button>
              ) : (
                <>
                  <Field label="Installation ID" hint="GitHub App 安装 ID，或 Mock 模式下的占位值。">
                    <input className="input" value={installationId} onChange={(event) => setInstallationId(event.target.value)} placeholder="12345678" />
                  </Field>
                  <div className="form-row">
                    <Field label="仓库 Owner">
                      <input className="input" value={repoOwner} onChange={(event) => setRepoOwner(event.target.value)} placeholder="demo-org" />
                    </Field>
                    <Field label="仓库名">
                      <input className="input" value={repoName} onChange={(event) => setRepoName(event.target.value)} placeholder="hello-world" />
                    </Field>
                  </div>
                  <Field label="默认分支">
                    <input className="input" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" />
                  </Field>
                  <div className="form-actions">
                    <Button size="sm" onClick={() => setFormOpen(false)}>
                      收起
                    </Button>
                    <Button variant="primary" size="sm" onClick={bindManual} disabled={!installationId.trim() || !repoOwner.trim() || !repoName.trim()}>
                      绑定
                    </Button>
                  </div>
                </>
              )}
              {!owner ? <p className="small muted">只有项目 Owner 可以绑定仓库。</p> : null}
            </div>
          </Card>
        </div>
      ) : null}

      {candidates ? (
        <Card
          title="选择要绑定的仓库"
          extra={
            <>
              <Button size="sm" onClick={loadCandidates} loading={loadingCandidates}>
                刷新
              </Button>
              <Button size="sm" variant="subtle" onClick={() => setCandidates(null)}>
                收起
              </Button>
            </>
          }
        >
          {candidates.length === 0 ? <EmptyState title="没有可用的仓库" hint="请确认 GitHub App 已授权该组织的仓库。" /> : null}
          <div className="run-list">
            {candidates.map((candidate) => (
              <div className="run-card" key={candidate.fullName}>
                <div className="run-card__head">
                  <div className="run-card__id">
                    <strong>{candidate.fullName}</strong>
                    <Badge tone="neutral" label={candidate.private ? '私有' : '公开'} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="small muted">
                      默认分支 <code className="mono">{candidate.defaultBranch}</code>
                    </span>
                    <Button size="sm" variant="primary" onClick={() => bindCandidate(candidate)} disabled={!owner}>
                      绑定
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      <ErrorNotice message={error} />
    </div>
  )
}
