import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, type GroupJoinOutcome, type JoinPreview } from '../api'
import { useSession } from '../session'
import { Badge, Button, ErrorNotice, ErrorState, Spinner, useToast } from '../components'
import { PROVIDER_LABELS } from '../format'

type AcceptResult = { projectId: string; role: string; alreadyMember: boolean; group: GroupJoinOutcome }

export function WecomJoinPage() {
  const { token } = useParams<{ token: string }>()
  const { user, session, loading: sessionLoading } = useSession()
  const navigate = useNavigate()
  const { notify } = useToast()
  const [preview, setPreview] = useState<JoinPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [accepting, setAccepting] = useState(false)
  const [result, setResult] = useState<AcceptResult | null>(null)
  const attempted = useRef(false)

  useEffect(() => {
    if (!token) return
    api.wecomJoin
      .preview(token)
      .then(setPreview)
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : '二维码校验失败'))
      .finally(() => setLoading(false))
  }, [token])

  useEffect(() => {
    if (!token || !user || !preview?.valid || attempted.current) return
    attempted.current = true
    setAccepting(true)
    setError(null)
    api.wecomJoin
      .accept(token)
      .then((accepted) => {
        setResult(accepted)
        notify(accepted.group.joined ? '已加入项目并进入企业微信群' : '已加入项目', accepted.group.joined ? 'success' : 'info')
        window.dispatchEvent(new Event('projects:changed'))
      })
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : '加入失败'))
      .finally(() => setAccepting(false))
  }, [token, user, preview, notify])

  if (loading || sessionLoading) {
    return (
      <div className="invite-page">
        <Spinner label="正在校验入群二维码…" />
      </div>
    )
  }

  if (error && !result) {
    return (
      <div className="invite-page">
        <div className="invite-card">
          <ErrorState message={error} />
          <div className="form-actions">
            <Link className="btn btn--ghost" to="/">
              返回首页
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (!preview?.valid) {
    return (
      <div className="invite-page">
        <div className="invite-card">
          <div className="notice notice--warning">
            {preview?.reason === 'invalid' ? '入群二维码无效或已过期。' : '对应的企业微信群已失效，请联系项目 Owner 重新生成。'}
          </div>
          <div className="form-actions">
            <Link className="btn btn--ghost" to="/">
              返回首页
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="invite-page">
      <div className="invite-card">
        <div className="invite-card__top">
          <div className="sidebar__brand" style={{ padding: 0 }}>
            <span className="brand-mark">S</span>
            <div>
              <strong style={{ color: 'var(--ink)' }}>Superagent</strong>
              <span style={{ color: 'var(--muted)' }}>企业微信扫码入群</span>
            </div>
          </div>
          <Badge tone="brand" label="自动入群" />
        </div>

        <div className="invite-project">
          <span>你正在加入</span>
          <strong>{preview.project?.name}</strong>
          <span>
            {preview.project?.slug} · {PROVIDER_LABELS.wecom} · {preview.group?.name ?? '项目群'}
          </span>
        </div>

        {accepting ? <Spinner label="正在加入项目并拉你进群…" /> : null}
        <ErrorNotice message={error} />

        {result ? (
          <div className="invite-group" style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <strong>{result.group.joined ? '已加入项目群' : '已加入项目，但未能自动进群'}</strong>
              <Badge tone={result.group.joined ? 'success' : 'warning'} label={result.group.joined ? '已入群' : '待入群'} />
            </div>
            <p className="small muted">
              {result.group.joined
                ? '你已在企业微信项目群中，可以直接在群里 @机器人 提需求。'
                : `自动拉群未成功：${result.group.error ?? '请确认应用可见范围包含你，或联系 Owner 手动拉群。'}`}
            </p>
            <div className="form-actions">
              <Button variant="primary" onClick={() => navigate(`/projects/${result.projectId}`, { replace: true })}>
                进入项目控制台
              </Button>
            </div>
          </div>
        ) : !user ? (
          <div className="form-stack" style={{ marginTop: 16 }}>
            <div className="notice notice--info">使用企业微信登录后会自动加入项目并拉你进项目群。</div>
            {session?.auth.oauth.wecom ? (
              <a className="btn btn--primary btn--block" href={`/v1/auth/wecom/start?returnTo=${encodeURIComponent(`/join/${token ?? ''}`)}`}>
                使用企业微信登录并加入
              </a>
            ) : null}
            <Link className="btn btn--ghost btn--block" to={`/login?next=${encodeURIComponent(`/join/${token ?? ''}`)}`}>
              使用其他方式登录
            </Link>
          </div>
        ) : (
          <div className="form-actions" style={{ marginTop: 16 }}>
            <Button
              variant="primary"
              loading={accepting}
              onClick={async () => {
                if (!token) return
                setAccepting(true)
                try {
                  setResult(await api.wecomJoin.accept(token))
                } catch (cause) {
                  setError(cause instanceof ApiError ? cause.message : '加入失败')
                } finally {
                  setAccepting(false)
                }
              }}
            >
              加入项目并进入项目群
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
