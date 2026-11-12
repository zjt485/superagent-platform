import { useState } from 'react'
import { api, ApiError, type Invite } from '../../api'
import { Badge, Button, Card, ConfirmButton, CopyButton, EmptyState, ErrorNotice, ErrorState, Field, Spinner, useAsync, useToast } from '../../components'
import { ROLE_LABELS, formatDate, relativeTime } from '../../format'
import type { ProjectTabProps } from './types'
import { isOwner } from './types'

export function InvitesTab({ project, role }: ProjectTabProps) {
  const owner = isOwner(role)
  const { notify } = useToast()
  const state = useAsync(() => api.invites.list(project.id), [project.id])
  const [inviteRole, setInviteRole] = useState('member')
  const [maxUses, setMaxUses] = useState(50)
  const [expires, setExpires] = useState(72)
  const [created, setCreated] = useState<Invite | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const items = state.data?.items ?? []

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.invites.create(project.id, { role: inviteRole, maxUses, expiresInHours: expires })
      setCreated(result.invite)
      notify('邀请已生成', 'success')
      state.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '生成失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <Card title="生成邀请二维码" extra={<Badge tone="neutral" label={`角色 ${ROLE_LABELS[inviteRole] ?? inviteRole}`} />}>
        <div className="form-stack">
          <div className="form-row">
            <Field label="加入后的角色">
              <select className="select" value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>
                <option value="member">Member</option>
                <option value="maintainer">Maintainer</option>
                <option value="viewer">Viewer</option>
              </select>
            </Field>
            <Field label="最大使用次数">
              <input className="input" type="number" min={1} max={1000} value={maxUses} onChange={(event) => setMaxUses(Number(event.target.value) || 1)} />
            </Field>
          </div>
          <Field label="有效期（小时）" hint="邀请带签名 token，过期、撤销或用完即失效。">
            <input className="input" type="number" min={1} max={720} value={expires} onChange={(event) => setExpires(Number(event.target.value) || 1)} />
          </Field>
          <ErrorNotice message={error} />
          <div className="form-actions">
            <Button variant="primary" onClick={create} loading={busy} disabled={!owner}>
              生成邀请
            </Button>
          </div>
          {!owner ? <p className="small muted">只有 Owner 可以生成或撤销邀请。</p> : null}
        </div>
      </Card>

      {created ? (
        <Card
          title="新邀请"
          extra={
            <Button size="sm" variant="subtle" onClick={() => setCreated(null)}>
              收起
            </Button>
          }
        >
          <div className="qr-panel">
            {created.qrDataUrl ? <img src={created.qrDataUrl} alt="项目邀请二维码" /> : null}
            <div className="qr-panel__meta">
              <strong style={{ fontSize: 14 }}>扫码加入 {project.name}</strong>
              <span className="small muted">
                角色 {ROLE_LABELS[created.role] ?? created.role} · 有效期至 {formatDate(created.expiresAt)} · 最多 {created.maxUses} 次
              </span>
              <div className="invite-link">
                <code>{created.url}</code>
                <CopyButton value={created.url} label="复制链接" />
              </div>
              <span className="small muted">成员扫码后通过飞书 / 企业微信登录，即可加入项目。</span>
            </div>
          </div>
        </Card>
      ) : null}

      <Card title="邀请记录">
        {state.loading ? <Spinner label="正在加载邀请…" /> : null}
        {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
        {!state.loading && items.length === 0 ? <EmptyState title="还没有邀请记录" hint="生成邀请后，成员扫码登录即可加入项目。" /> : null}
        {items.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>角色</th>
                  <th>使用情况</th>
                  <th>有效期至</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((invite) => {
                  const expired = new Date(invite.expiresAt).getTime() <= Date.now()
                  const status = invite.revokedAt ? '已撤销' : expired ? '已过期' : invite.usedCount >= invite.maxUses ? '已用完' : '有效'
                  const tone = status === '有效' ? 'success' : status === '已用完' ? 'warning' : 'neutral'
                  return (
                    <tr key={invite.id}>
                      <td>{ROLE_LABELS[invite.role] ?? invite.role}</td>
                      <td>
                        {invite.usedCount} / {invite.maxUses}
                      </td>
                      <td className="small muted">{formatDate(invite.expiresAt)}</td>
                      <td>
                        <Badge tone={tone as 'success' | 'warning' | 'neutral'} label={status} />
                      </td>
                      <td className="small muted">{relativeTime(invite.createdAt)}</td>
                      <td className="table__actions">
                        {!invite.revokedAt && status === '有效' ? (
                          <ConfirmButton
                            size="sm"
                            variant="danger"
                            title="撤销邀请"
                            message="撤销后该二维码/链接立即失效，已加入的成员不受影响。"
                            confirmLabel="撤销"
                            danger
                            onConfirm={async () => {
                              try {
                                await api.invites.revoke(project.id, invite.id)
                                notify('邀请已撤销', 'success')
                                state.reload()
                              } catch (cause) {
                                notify(cause instanceof ApiError ? cause.message : '撤销失败', 'danger')
                              }
                            }}
                          >
                            撤销
                          </ConfirmButton>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </div>
  )
}
