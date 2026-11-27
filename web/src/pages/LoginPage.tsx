import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ApiError } from '../api'
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
      <main className="auth-main">
        <div className="auth-hero">
          <span className="brand-mark">S</span>
          <h1>Superagent</h1>
          <p>你的 AI 产研团队，7×24 在线协作。</p>
        </div>

        <div className="auth-card">
          <h1>登录</h1>
          <p>使用飞书 / 企业微信账号进入工作台，成员身份由项目邀请决定。</p>

          {hasOauth ? (
            <div className="form-stack">
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
            <div className="form-stack">
              <div className="notice notice--info">
                部署尚未配置飞书 / 企业微信 OAuth。开发环境可使用下方开发登录。
              </div>
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
                <Field label="昵称" hint="开发登录仅用于本地调试；生产环境应关闭 AUTH_DEV_LOGIN。">
                  <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Alice" maxLength={60} required />
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
