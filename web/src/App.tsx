import { useEffect, useState } from 'react'
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api, type ProjectSummary } from './api'
import { RequireAuth, SessionProvider, useSession } from './session'
import { ToastProvider } from './components'
import { ProjectsPage } from './pages/ProjectsPage'
import { ProjectPage } from './pages/ProjectPage'
import { TicketPage } from './pages/TicketPage'
import { LoginPage } from './pages/LoginPage'
import { InvitePage } from './pages/InvitePage'
import { WecomJoinPage } from './pages/WecomJoinPage'
import { NotFoundPage } from './pages/NotFoundPage'
import './styles.css'

type Theme = 'light' | 'dark'

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem('sa-theme')
    return saved === 'dark' ? 'dark' : 'light'
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('sa-theme', theme)
  }, [theme])
  return [theme, () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))]
}

function Shell() {
  const { user, logout } = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [theme, toggleTheme] = useTheme()

  useEffect(() => {
    let alive = true
    api.projects
      .list()
      .then((result) => alive && setProjects(result.items))
      .catch(() => alive && setProjects([]))
    return () => {
      alive = false
    }
  }, [location.pathname])

  useEffect(() => {
    const onChange = () => {
      void api.projects.list().then((result) => setProjects(result.items)).catch(() => {})
    }
    window.addEventListener('projects:changed', onChange)
    return () => window.removeEventListener('projects:changed', onChange)
  }, [])

  const activeProjectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <span className="brand-mark">S</span>
          <div>
            <strong>Superagent</strong>
            <span>Project Console</span>
          </div>
        </div>
        <nav className="sidebar__nav" aria-label="项目导航">
          <div className="nav-section">项目</div>
          {projects.length === 0 ? <div className="nav-empty">还没有项目。创建第一个项目并绑定仓库。</div> : null}
          {projects.map((project) => (
            <NavLink
              key={project.id}
              to={`/projects/${project.id}`}
              className={({ isActive }) => `nav-link ${isActive || activeProjectId === project.id ? 'nav-link--active' : ''}`}
            >
              <span className="nav-dot" data-status={project.status} aria-hidden />
              <span className="nav-link__name">{project.name}</span>
              {project.openTickets > 0 ? <span className="tab__count">{project.openTickets}</span> : null}
            </NavLink>
          ))}
          <button className="nav-link" onClick={() => navigate('/?new=1')} style={{ background: 'transparent', border: 'none', textAlign: 'left', width: '100%' }}>
            <span className="nav-link__name">＋ 新建项目</span>
          </button>
        </nav>
        <div className="sidebar__foot">
          <div className="user-chip">
            <span className="avatar avatar--sm">{user?.name.slice(0, 1).toUpperCase()}</span>
            <div className="user-chip__meta">
              <strong>{user?.name}</strong>
              <span>{user?.isAdmin ? '平台管理员' : '项目成员'}</span>
            </div>
          </div>
          <div className="sidebar__actions">
            <button className="icon-btn" onClick={toggleTheme} aria-label="切换主题" title={theme === 'dark' ? '切换到浅色' : '切换到深色'}>
              {theme === 'dark' ? '☀' : '☾'}
            </button>
            <Link className="icon-btn" to="/" aria-label="返回项目列表" title="项目列表">
              ⌂
            </Link>
            <button
              className="icon-btn"
              aria-label="退出登录"
              title="退出登录"
              onClick={async () => {
                await logout()
                navigate('/login')
              }}
            >
              ⏻
            </button>
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="topbar__crumbs">
            <Link to="/">控制台</Link>
            <span aria-hidden>/</span>
            <strong>{activeProjectId ? projects.find((project) => project.id === activeProjectId)?.name ?? '项目' : '全部项目'}</strong>
          </div>
          <div className="topbar__actions">
            <span className="badge badge--neutral">MVP v0.1</span>
          </div>
        </header>
        <main className="content">
          <Routes>
            <Route index element={<ProjectsPage />} />
            <Route path="projects/:projectId" element={<ProjectPage />} />
            <Route path="projects/:projectId/tickets/:ticketId" element={<TicketPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

function LoginRoute() {
  const { user, loading } = useSession()
  const location = useLocation()
  const next = new URLSearchParams(location.search).get('next') ?? '/'
  if (!loading && user) return <Navigate to={next.startsWith('/') && !next.startsWith('//') ? next : '/'} replace />
  return <LoginPage />
}

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <ToastProvider>
          <Routes>
            <Route path="/login" element={<LoginRoute />} />
            <Route path="/invite/:token" element={<InvitePage />} />
            <Route path="/join/:token" element={<WecomJoinPage />} />
            <Route
              path="/*"
              element={
                <RequireAuth>
                  <Shell />
                </RequireAuth>
              }
            />
          </Routes>
        </ToastProvider>
      </SessionProvider>
    </BrowserRouter>
  )
}
