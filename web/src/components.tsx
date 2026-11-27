import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ApiError } from './api'
import { initials, statusTone, type Tone } from './format'

// ---------------------------------------------------------------------------
// Async data
// ---------------------------------------------------------------------------

export interface AsyncState<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((value) => value + 1), [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    loader()
      .then((result) => {
        if (!alive) return
        setData(result)
      })
      .catch((cause) => {
        if (!alive) return
        setError(cause instanceof ApiError ? cause.message : '加载失败，请稍后重试')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  return { data, error, loading, reload }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface ToastItem {
  id: number
  message: string
  tone: 'info' | 'success' | 'danger'
}

const ToastContext = createContext<{ notify: (message: string, tone?: ToastItem['tone']) => void } | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const counter = useRef(0)
  const notify = useCallback((message: string, tone: ToastItem['tone'] = 'info') => {
    const id = ++counter.current
    setItems((current) => [...current, { id, message, tone }])
    window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), 4200)
  }, [])
  const value = useMemo(() => ({ notify }), [notify])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast--${item.tone}`}>
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside ToastProvider')
  return context
}

// ---------------------------------------------------------------------------
// Buttons and badges
// ---------------------------------------------------------------------------

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'subtle' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
}

export function Button({ variant = 'ghost', size = 'md', loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={['btn', `btn--${variant}`, size === 'sm' ? 'btn--sm' : '', className ?? ''].filter(Boolean).join(' ')}
    >
      {loading ? <span className="btn__spinner" aria-hidden /> : null}
      {children}
    </button>
  )
}

export function Badge({ status, label, tone }: { status?: string; label?: ReactNode; tone?: Tone }) {
  const resolved = tone ?? statusTone(status ?? '')
  return (
    <span className={`badge badge--${resolved}`} data-status={status}>
      <span className="badge__dot" aria-hidden />
      {label ?? status ?? '—'}
    </span>
  )
}

export function RoleBadge({ role }: { role: string }) {
  const tone: Tone = role === 'owner' ? 'brand' : role === 'maintainer' ? 'info' : role === 'member' ? 'neutral' : 'neutral'
  return <Badge tone={tone} label={role === 'owner' ? 'Owner' : role === 'maintainer' ? 'Maintainer' : role === 'member' ? 'Member' : 'Viewer'} />
}

export function Avatar({ name, size }: { name: string; size?: 'sm' | 'md' }) {
  return <span className={`avatar ${size === 'sm' ? 'avatar--sm' : ''}`}>{initials(name)}</span>
}

export function initialsOf(name: string): string {
  return initials(name)
}

export type IconName =
  | 'sun'
  | 'moon'
  | 'home'
  | 'power'
  | 'plus'
  | 'chevron-down'
  | 'close'
  | 'tray'
  | 'plug'
  | 'clock'
  | 'chat'
  | 'sparkle'
  | 'check'

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </>
    ),
    moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
    home: (
      <>
        <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
      </>
    ),
    power: (
      <>
        <path d="M12 2v10" />
        <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    'chevron-down': <path d="m6 9 6 6 6-6" />,
    close: <path d="M18 6 6 18M6 6l12 12" />,
    tray: (
      <>
        <path d="M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7" />
        <path d="M4 13h4l2 3h4l2-3h4v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      </>
    ),
    plug: (
      <>
        <path d="M12 22v-5" />
        <path d="M9 8V2M15 8V2" />
        <path d="M7 8h10v4a5 5 0 0 1-10 0z" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    chat: <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z" />,
    sparkle: <path d="m12 3 1.8 4.8L18.5 9.5l-4.7 1.7L12 16l-1.8-4.8L5.5 9.5l4.7-1.7z" />,
    check: <path d="M20 6 9 17l-5-5" />,
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="state state--loading">
      <span className="spinner" aria-hidden />
      {label ? <span>{label}</span> : null}
    </div>
  )
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="state state--empty">
      <div className="state__mark" aria-hidden>
        <Icon name="tray" size={22} />
      </div>
      <strong>{title}</strong>
      {hint ? <span>{hint}</span> : null}
      {action ? <div className="state__action">{action}</div> : null}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state--error">
      <div className="state__mark" aria-hidden>
        !
      </div>
      <strong>加载失败</strong>
      <span>{message}</span>
      {onRetry ? (
        <Button size="sm" variant="primary" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  )
}

export function ErrorNotice({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="notice notice--danger" role="alert">
      {message}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function Card({ title, extra, children, className }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={['card', className ?? ''].filter(Boolean).join(' ')}>
      {title || extra ? (
        <header className="card__head">
          <h2>{title}</h2>
          {extra ? <div className="card__extra">{extra}</div> : null}
        </header>
      ) : null}
      <div className="card__body">{children}</div>
    </section>
  )
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  )
}

export function StatCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className={`stat ${tone ? `stat--${tone}` : ''}`}>
      <span className="stat__label">{label}</span>
      <strong className="stat__value">{value}</strong>
      {hint ? <span className="stat__hint">{hint}</span> : null}
    </div>
  )
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  )
}

export function Tabs({
  items,
  value,
  onChange,
}: {
  items: { key: string; label: string; count?: number }[]
  value: string
  onChange: (key: string) => void
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          role="tab"
          aria-selected={item.key === value}
          className={`tab ${item.key === value ? 'tab--active' : ''}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
          {item.count !== undefined ? <span className="tab__count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Modal and confirmation
// ---------------------------------------------------------------------------

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal__head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  )
}

export function ConfirmButton({
  children,
  title,
  message,
  confirmLabel = '确认',
  danger,
  onConfirm,
  variant = 'ghost',
  size,
}: {
  children: ReactNode
  title: string
  message: ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => Promise<void> | void
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal
        open={open}
        title={title}
        onClose={() => !busy && setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button
              variant={danger ? 'danger' : 'primary'}
              loading={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await onConfirm()
                  setOpen(false)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        <div className="confirm-text">{message}</div>
      </Modal>
    </>
  )
}

export function CopyButton({ value, label = '复制' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      variant="subtle"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1600)
        } catch {
          setCopied(false)
        }
      }}
    >
      {copied ? '已复制' : label}
    </Button>
  )
}
