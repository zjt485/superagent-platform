import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, type GroupJoinOutcome } from '../api'
import { useSession } from '../session'
import { Avatar, Badge, Button, ErrorNotice, ErrorState, Spinner, useToast } from '../components'
import { PROVIDER_LABELS, ROLE_LABELS, formatDate } from '../format'

const REASONS: Record<string, string> = {
  not_found: '邀请不存在或链接不完整。',
  expired: '邀请已过期，请联系项目 Owner 重新生成。',
  revoked: '邀请已被项目管理员撤销。',
  exhausted: '邀请使用次数已用完。',
  archived: '项目已归档，无法加入。',
}

export function InvitePage() {
  const { token } = useParams<{ token: string }>()
  const { user, loading: sessionLoading } = useSession()
  const navigate = useNavigate()
  const { notify } = useToast()
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.invites.preview>>['invite'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [joinOutcome, setJoinOutcome] = useState<GroupJoinOutcome | null>(null)
  const [acceptedProjectId, setAcceptedProjectId] = useState<string | null>(null)

  const load = () => {
    if (!token) return
    setLoading(true)
    api.invites
      .preview(token)
      .then((result) => setPreview(result.invite))
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : '邀请加载失败'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  if (loading || sessionLoading) {
    return (
      <div className="invite-page">
        <Spinner label="正在校验邀请…" />
      </div>
    )
  }

  const accept = async () => {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.invites.accept(token)
      window.dispatchEvent(new Event('projects:changed'))
      setAcceptedProjectId(result.project.id)
      if (result.group?.group) {
        // Stay on the invitation page so the new member can scan the group QR
        // or open the group link before entering the console.
        setJoinOutcome(result.group)
        notify(result.group.joined ? '已加入项目，并自动加入项目群' : '已加入项目', 'success')
      } else {
        notify(result.alreadyMember ? '你已经是项目成员' : '已加入项目', 'success')
        navigate(`/projects/${result.project.id}`, { replace: true })
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '加入失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="invite-page">
      <div className="invite-card">
        <div className="invite-card__top">
          <div className="sidebar__brand" style={{ padding: 0 }}>
            <span className="brand-mark">S</span>
            <div>
              <strong style={{ color: 'var(--ink)' }}>Superagent</strong>
              <span style={{ color: 'var(--muted)' }}>项目邀请</span>
            </div>
          </div>
          <span className="badge badge--neutral">邀请链接</span>
        </div>

        {error ? <ErrorState message={error} onRetry={load} /> : null}
        {!error && preview && !preview.valid ? (
          <>
            <div className="notice notice--warning">{REASONS[preview.reason ?? 'not_found'] ?? '邀请不可用。'}</div>
            {preview.project ? <p className="small muted" style={{ marginTop: 12 }}>项目：{preview.project.name}</p> : null}
            <div className="form-actions">
              <Link className="btn btn--ghost" to="/">
                返回首页
              </Link>
            </div>
          </>
        ) : null}
        {!error && preview?.valid && preview.project ? (
          <>
            <div className="invite-project">
              <span>你被邀请加入</span>
              <strong>{preview.project.name}</strong>
              <span>
                {preview.project.slug} · 角色 {ROLE_LABELS[preview.role ?? 'member'] ?? preview.role}
              </span>
            </div>
            <dl className="kv-list" style={{ marginTop: 16 }}>
              <div>
                <dt>邀请有效期</dt>
                <dd>{formatDate(preview.expiresAt)}</dd>
              </div>
              <div>
                <dt>剩余名额</dt>
                <dd>
                  {Math.max((preview.maxUses ?? 0) - (preview.usedCount ?? 0), 0)} / {preview.maxUses ?? 0}
                </dd>
              </div>
              <div>
                <dt>项目群入口</dt>
                <dd>
                  {preview.group
                    ? `${PROVIDER_LABELS[preview.group.provider] ?? preview.group.provider} · ${preview.group.name ?? preview.group.chatId}（加入后可扫码/点链接入群）`
                    : preview.chatProvider
                      ? '已绑定 IM 群，加入后可在控制台查看'
                      : '项目尚未绑定群'}
                </dd>
              </div>
            </dl>
            {user ? (
              joinOutcome ? (
                <div className="invite-group">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <strong>{joinOutcome.joined ? '已自动加入项目群' : '最后一步：加入项目群'}</strong>
                    <Badge tone={joinOutcome.joined ? 'success' : 'warning'} label={joinOutcome.joined ? '已入群' : '待入群'} />
                  </div>
                  {joinOutcome.group ? (
                    <div className="qr-panel" style={{ padding: 12 }}>
                      {!joinOutcome.joined && joinOutcome.group.qrDataUrl ? (
                        <img src={joinOutcome.group.qrDataUrl} alt="项目群二维码" style={{ width: 148, height: 148 }} />
                      ) : null}
                      <div className="qr-panel__meta">
                        <strong style={{ fontSize: 13 }}>
                          {PROVIDER_LABELS[joinOutcome.group.provider] ?? joinOutcome.group.provider} · {joinOutcome.group.name ?? '项目群'}
                        </strong>
                        <span className="small muted">
                          {joinOutcome.joined
                            ? '你已在项目群中，可以直接在群里 @bot 提需求。'
                            : joinOutcome.group.qrDataUrl
                              ? '请用手机扫码加入项目群，或在下方打开群链接。'
                              : '管理员还没有上传群二维码，可先打开群链接或联系 Owner。'}
                        </span>
                        {joinOutcome.error ? (
                          <span className="small" style={{ color: 'var(--warning)' }}>
                            自动拉群未成功：{joinOutcome.error}
                          </span>
                        ) : null}
                        {joinOutcome.group.joinUrl ? (
                          <a className="btn btn--sm btn--primary" href={joinOutcome.group.joinUrl} target="_blank" rel="noreferrer">
                            打开项目群 ↗
                          </a>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  <div className="form-actions">
                    <Button variant="primary" onClick={() => acceptedProjectId && navigate(`/projects/${acceptedProjectId}`, { replace: true })}>
                      进入项目控制台
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="notice notice--info" style={{ marginTop: 16 }}>
                    当前登录：{user.name}。加入后你可以在控制台查看项目，并在群内 @bot 提需求。
                  </div>
                  <ErrorNotice message={error} />
                  <div className="form-actions">
                    <Button variant="primary" onClick={accept} loading={busy}>
                      接受邀请并加入
                    </Button>
                  </div>
                </>
              )
            ) : (
              <>
                <div className="notice notice--info" style={{ marginTop: 16 }}>
                  接受邀请前需要先登录。登录后会回到本页面。
                </div>
                <div className="form-actions">
                  <Link className="btn btn--primary" to={`/login?next=${encodeURIComponent(`/invite/${token ?? ''}`)}`}>
                    登录并接受邀请
                  </Link>
                </div>
              </>
            )}
          </>
        ) : null}
        {!error && !preview ? <ErrorState message="邀请加载失败" onRetry={load} /> : null}
        <p className="auth-foot" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <Avatar name={user?.name ?? '访客'} size="sm" />
          {user ? `已登录：${user.name}` : '未登录'}
        </p>
      </div>
    </div>
  )
}
