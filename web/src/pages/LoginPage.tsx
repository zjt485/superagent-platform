import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api, ApiError } from '../api'
import { useSession } from '../session'
import { Button, ErrorNotice, Field, Spinner } from '../components'

function safeNext(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}

export function LoginPage() {
  const { session, loading, loginDev } = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  const next = safeNext(new URLSearchParams(location.search).get('next'))
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (loading) {
    return (
      <div className="full-page-center">
        <Spinner label="正在加载…" />
      </div>
    )
  }

  const oauth = session?.auth.oauth ?? { feishu: false, wecom: false }
  const hasOauth = oauth.feishu || oauth.wecom

  const startOauth = (provider: 'feishu' | 'wecom') => {
    window.location.href = `/v1/auth/${provider}/start?returnTo=${encodeURIComponent(next)}`
  }

  return (
    <div className="auth-page">
      <aside className="auth-aside">
        <div>
          <div className="sidebar__brand" style={{ padding: 0 }}>
            <span className="brand-mark">S</span>
            <div>
              <strong style={{ fontSize: 16 }}>Superagent</strong>
              <span>Multi-project agent platform</span>
            </div>
          </div>
          <h2>把群里的每一句需求，变成可评审的 PR。</h2>
          <p>
            项目组绑定一个 GitHub 仓库和一个 IM 群。成员在群里 @bot 提需求，Agent 在隔离环境中改代码、跑测试、开 PR，
            全过程可审计，人工负责最终合并。
          </p>
          <ul className="auth-points">
            <li>@bot 自动建单，线程追问自动追加</li>
            <li>计划与合并都需要人来批准</li>
            <li>每项目独立策略、并发与预算</li>
            <li>消息 → 工单 → 运行 → PR 全链路留痕</li>
          </ul>
        </div>
        <p style={{ fontSize: 11, color: '#7d90ac' }}>控制面与 Worker 分离 · 单机 Docker Compose 可部署</p>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <div className="badge badge--brand">控制台登录</div>
          <h1>进入项目工作台</h1>
          <p>使用飞书 / 企业微信账号登录，成员身份由项目邀请决定。</p>

          {hasOauth ? (
            <div className="form-stack" style={{ marginTop: 20 }}>
              {oauth.feishu ? (
                <Button variant="primary" className="btn--block" onClick={() => startOauth('feishu')}>
                  使用飞书登录
                </Button>
              ) : null}
              {oauth.wecom ? (
                <Button variant={oauth.feishu ? 'ghost' : 'primary'} className="btn--block" onClick={() => startOauth('wecom')}>
                  使用企业微信登录
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="notice notice--info" style={{ marginTop: 20 }}>
              部署尚未配置飞书 / 企业微信 OAuth。开发环境可使用下方开发登录。
            </div>
          )}

          {session?.auth.devLogin ? (
            <>
              <div className="auth-divider">{hasOauth ? '或使用开发登录' : '开发登录'}</div>
              <form
                className="form-stack"
                onSubmit={async (event) => {
                  event.preventDefault()
                  setBusy(true)
                  setError(null)
                  try {
                    await loginDev(name.trim())
                    navigate(next, { replace: true })
                  } catch (cause) {
                    setError(cause instanceof ApiError ? cause.message : '登录失败')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                <Field label="昵称" hint="开发登录只用于本地调试；生产环境应关闭 AUTH_DEV_LOGIN。">
                  <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：张三" maxLength={60} required />
                </Field>
                <Button variant="primary" className="btn--block" type="submit" loading={busy} disabled={!name.trim()}>
                  进入控制台
                </Button>
              </form>
            </>
          ) : null}
          <ErrorNotice message={error} />
          <p className="auth-foot">
            扫码加入项目？请打开邀请链接。
            <br />
            <Link to="/">返回首页</Link>
          </p>
        </div>
      </main>
    </div>
  )
}
