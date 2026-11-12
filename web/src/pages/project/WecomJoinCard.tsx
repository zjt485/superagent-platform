import { useState } from 'react'
import { api, ApiError, type ProjectBundle, type ProjectJoinLink } from '../../api'
import { Badge, Button, Card, CopyButton, ErrorNotice, Spinner, useAsync, useToast } from '../../components'
import { formatDate } from '../../format'
import { canMaintain, isOwner, type ProjectTabProps } from './types'

/**
 * The only real "scan to join" path on WeCom: an app-managed group created via
 * appchat, plus a platform QR whose acceptance calls appchat/update.
 */
export function WecomJoinCard({ project, role, refresh, onNavigate }: ProjectTabProps) {
  const { notify } = useToast()
  const maintainer = canMaintain(role)
  const owner = isOwner(role)
  const [created, setCreated] = useState<ProjectJoinLink | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = useAsync(
    async () => {
      if (!maintainer) return { channel: null, join: null as ProjectJoinLink | null, reason: 'forbidden' }
      return api.projects.joinLink(project.id)
    },
    [project.id, maintainer],
  )

  if (!maintainer) {
    return (
      <Card title="企业微信扫码入群">
        <p className="small muted">请联系项目 Owner 或 Maintainer 获取企业微信扫码入群二维码。</p>
      </Card>
    )
  }

  const join = created ?? state.data?.join ?? null
  const activeChannel = state.data?.channel ?? project.channel
  const managed = activeChannel?.provider === 'wecom' && (state.data?.join || created)
  const otherGroup = activeChannel && activeChannel.provider !== 'wecom'

  const create = async () => {
    setCreating(true)
    setError(null)
    try {
      const result = await api.projects.createWecomGroup(project.id)
      setCreated(result.join)
      notify('企业微信群已创建，扫码即可自动入群', 'success')
      refresh()
      window.dispatchEvent(new Event('projects:changed'))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建企业微信群失败')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Card
      title="企业微信扫码入群"
      extra={
        managed ? (
          <Badge tone="success" label="应用群 · 自动入群" />
        ) : otherGroup ? (
          <Badge tone="warning" label="已绑定其他平台" />
        ) : (
          <Badge tone="neutral" label="未创建" />
        )
      }
    >
      <ErrorNotice message={error ?? state.error} />
      {state.loading && !created ? <Spinner label="正在读取入群二维码…" /> : null}
      {!project.repo ? (
        <p className="small muted">先绑定 GitHub 仓库，再创建企业微信群并生成扫码入群二维码。</p>
      ) : otherGroup ? (
        <div className="stack">
          <p className="small muted">
            项目已绑定 {activeChannel?.provider === 'feishu' ? '飞书' : '其他'} 群。企业微信扫码入群需要先在「IM 群」解绑，再创建应用群。
          </p>
          <Button size="sm" onClick={() => onNavigate('channel')}>
            去 IM 群设置
          </Button>
        </div>
      ) : join ? (
        <div className="qr-panel">
          <img src={join.qrDataUrl} alt="企业微信扫码入群二维码" />
          <div className="qr-panel__meta">
            <strong style={{ fontSize: 14 }}>扫码加入 {project.name} 企业微信群</strong>
            <span className="small muted">
              使用企业微信扫码 → OAuth 登录 → 自动加入项目并拉入项目群。二维码有效期至 {formatDate(join.expiresAt)}。
            </span>
            <div className="invite-link">
              <code>{join.url}</code>
              <CopyButton value={join.url} label="复制链接" />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button size="sm" variant="subtle" onClick={state.reload} loading={state.loading}>
                刷新二维码
              </Button>
              {owner ? (
                <span className="small muted" style={{ alignSelf: 'center' }}>
                  群由应用创建，已自动把项目内已有企业微信成员加入。
                </span>
              ) : null}
            </div>
          </div>
        </div>
      ) : state.data?.reason === 'not_managed' ? (
        <div className="stack">
          <div className="notice notice--warning">
            当前绑定的是已有企业微信群，企业微信 API 不能把成员加入非应用创建的群。请先解绑，再创建应用群，扫码后即可自动拉人。
          </div>
          <Button size="sm" onClick={() => onNavigate('channel')}>
            去 IM 群解绑
          </Button>
        </div>
      ) : (
        <div className="stack">
          <p className="small muted">
            创建一个由应用管理的项目群（包含当前 Owner 和项目内有企业微信身份的成员），然后生成二维码。扫描者用企业微信登录后会被直接拉入该群。
          </p>
          <Button variant="primary" onClick={create} loading={creating} disabled={!owner}>
            创建企业微信群并生成二维码
          </Button>
          {!owner ? <p className="small muted">只有 Owner 可以创建并绑定企业微信群。</p> : null}
        </div>
      )}
    </Card>
  )
}
