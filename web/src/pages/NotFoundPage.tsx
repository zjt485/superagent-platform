import { Link, useNavigate } from 'react-router-dom'
import { Badge, EmptyState } from '../components'

export function NotFoundPage() {
  const navigate = useNavigate()
  return (
    <div className="card">
      <div className="card__body">
        <EmptyState
          title="页面不存在"
          hint="链接可能已失效，或者你没有访问权限。"
          action={<Link className="btn btn--primary" to="/">返回项目列表</Link>}
        />
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Badge tone="neutral" label="404" />
        </div>
        <div style={{ height: 8 }} />
        <button className="btn btn--subtle" onClick={() => navigate(-1)} style={{ margin: '0 auto', display: 'flex' }}>
          返回上一页
        </button>
      </div>
    </div>
  )
}
