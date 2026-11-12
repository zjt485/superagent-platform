import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { api, ApiError, type SessionInfo, type User } from './api'
import { Spinner } from './components'

interface SessionContextValue {
  session: SessionInfo | null
  user: User | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  loginDev: (name: string) => Promise<User>
  logout: () => Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await api.session()
      setSession(next)
      setError(null)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '无法连接服务器')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loginDev = useCallback(async (name: string) => {
    const result = await api.devLogin(name)
    const next = await api.session()
    setSession(next)
    return result.user
  }, [])

  const logout = useCallback(async () => {
    await api.logout()
    setSession((current) => (current ? { ...current, user: null } : current))
  }, [])

  const value = useMemo<SessionContextValue>(
    () => ({ session, user: session?.user ?? null, loading, error, refresh, loginDev, logout }),
    [session, loading, error, refresh, loginDev, logout],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext)
  if (!context) throw new Error('useSession must be used inside SessionProvider')
  return context
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useSession()
  const location = useLocation()
  if (loading) {
    return (
      <div className="full-page-center">
        <Spinner label="正在加载控制台…" />
      </div>
    )
  }
  if (!user) {
    const next = `${location.pathname}${location.search}`
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }
  return <>{children}</>
}
