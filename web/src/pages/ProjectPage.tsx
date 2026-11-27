import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError, type ProjectStatus } from '../api'
import { Badge, Button, ConfirmButton, ErrorNotice, ErrorState, Icon, PageHeader, Spinner, Tabs, useAsync, useToast } from '../components'
import { labelOf } from '../format'
import { canMaintain, isOwner, type ProjectTabProps } from './project/types'
import { OverviewTab } from './project/OverviewTab'
import { RoomsTab } from './project/RoomsTab'
import { RosterTab } from './project/RosterTab'
import { InboxTab } from './project/InboxTab'
import { RoutinesTab } from './project/RoutinesTab'
import { ConnectorsTab } from './project/ConnectorsTab'
import { MainSessionTab } from './project/MainSessionTab'
import { TicketsTab } from './project/TicketsTab'
import { MembersTab } from './project/MembersTab'
import { ChannelTab } from './project/ChannelTab'
import { RepoTab } from './project/RepoTab'
import { InvitesTab } from './project/InvitesTab'
import { SettingsTab } from './project/SettingsTab'
import { AuditTab } from './project/AuditTab'
import { UsageTab } from './project/UsageTab'

const PRIMARY_TABS = ['rooms', 'roster', 'inbox', 'routines', 'connectors'] as const
const SECONDARY_TABS = ['overview', 'tickets', 'session', 'members', 'channel', 'repo', 'invites', 'settings', 'audit', 'usage'] as const
const TAB_KEYS = [...PRIMARY_TABS, ...SECONDARY_TABS] as const
type TabKey = (typeof TAB_KEYS)[number]

const TAB_LABELS: Record<TabKey, string> = {
  rooms: '协作房间',
  roster: 'Bot 团队',
  inbox: '审批收件箱',
  routines: '定时巡检',
  connectors: '连接器',
  overview: '概览',
  tickets: '工单',
  session: 'Router',
  members: '成员',
  channel: 'IM 群',
  repo: '仓库',
  invites: '邀请',
  settings: '设置',
  audit: '审计',
  usage: '用量',
}

function MoreMenu({
  items,
  activeTab,
  onSelect,
}: {
  items: TabKey[]
  activeTab: TabKey
  onSelect: (key: TabKey) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const isSecondary = (SECONDARY_TABS as readonly string[]).includes(activeTab)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} style={{ position: 'relative', flexShrink: 0 }}>
      <Button
        size="sm"
        variant="subtle"
        className={isSecondary ? 'more-btn--active' : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{isSecondary ? TAB_LABELS[activeTab] : '更多'}</span>
        <Icon name="chevron-down" size={14} />
      </Button>
      {open ? (
        <div className="more-menu" role="menu">
          {items.map((key) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              className={`more-menu__item ${activeTab === key ? 'more-menu__item--active' : ''}`}
              onClick={() => {
                setOpen(false)
                onSelect(key)
              }}
            >
              <span>{TAB_LABELS[key]}</span>
              {activeTab === key ? <Icon name="check" size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const { notify } = useToast()
  const state = useAsync(() => api.projects.get(projectId ?? ''), [projectId])
  const [statusBusy, setStatusBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  if (state.loading) {
    return (
      <div className="full-page-center" style={{ minHeight: 240 }}>
        <Spinner label="正在加载项目…" />
      </div>
    )
  }
  if (state.error || !state.data) {
    return <ErrorState message={state.error ?? '项目不存在'} onRetry={state.reload} />
  }

  const project = state.data.project
  const role = project.role
  const owner = isOwner(role)
  const tabParam = searchParams.get('tab')
  const tab: TabKey = TAB_KEYS.includes(tabParam as TabKey) ? (tabParam as TabKey) : 'rooms'
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams)
    params.set('tab', next)
    setSearchParams(params, { replace: true })
  }

  const changeStatus = async (status: ProjectStatus) => {
    setStatusBusy(true)
    setActionError(null)
    try {
      await api.projects.update(project.id, { status })
      notify(status === 'active' ? '项目已启用' : status === 'paused' ? '项目已暂停' : '项目已归档', 'success')
      state.reload()
      window.dispatchEvent(new Event('projects:changed'))
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : '状态更新失败')
    } finally {
      setStatusBusy(false)
    }
  }

  const tabProps: ProjectTabProps = { project, role, refresh: state.reload, onNavigate: setTab }
  const visibleSecondary = (SECONDARY_TABS as readonly TabKey[]).filter((key) => {
    if ((key === 'invites' || key === 'audit') && role === 'viewer') return false
    return true
  })
  const activePrimary = (PRIMARY_TABS as readonly string[]).includes(tab) ? tab : ''

  return (
    <>
      <PageHeader
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            {project.name}
            <Badge status={project.status} label={labelOf(project.status)} />
          </span>
        }
        subtitle={
          <span>
            <code className="mono">{project.slug}</code>
            {project.description ? ` · ${project.description}` : ''}
          </span>
        }
        actions={
          <>
            <Button variant="subtle" size="sm" onClick={state.reload}>
              刷新
            </Button>
            {owner && project.status === 'draft' ? (
              <Button
                variant="primary"
                size="sm"
                loading={statusBusy}
                disabled={!project.readiness.canActivate}
                title={project.readiness.canActivate ? '启用项目' : '需要先绑定仓库与 IM 群'}
                onClick={() => changeStatus('active')}
              >
                启用项目
              </Button>
            ) : null}
            {canMaintain(role) && project.status === 'active' ? (
              <>
                <Button size="sm" loading={statusBusy} onClick={() => changeStatus('paused')}>
                  暂停
                </Button>
                {owner ? (
                  <ConfirmButton
                    size="sm"
                    title="归档项目"
                    message="归档后项目只读，不再接收消息和调度。此操作不可撤销。"
                    confirmLabel="归档"
                    danger
                    onConfirm={() => changeStatus('archived')}
                  >
                    归档
                  </ConfirmButton>
                ) : null}
              </>
            ) : null}
            {canMaintain(role) && project.status === 'paused' ? (
              <>
                <Button variant="primary" size="sm" loading={statusBusy} onClick={() => changeStatus('active')}>
                  恢复
                </Button>
                {owner ? (
                  <ConfirmButton size="sm" title="归档项目" message="归档后项目只读，不再接收消息和调度。" confirmLabel="归档" danger onConfirm={() => changeStatus('archived')}>
                    归档
                  </ConfirmButton>
                ) : null}
              </>
            ) : null}
          </>
        }
      />

      <ErrorNotice message={actionError} />

      {project.status === 'draft' ? (
        <div className="notice notice--warning" style={{ marginBottom: 16 }}>
          项目仍是草稿：{project.readiness.repo ? '仓库已绑定' : '缺少仓库'}，{project.readiness.channel ? 'IM 群已绑定' : '缺少 IM 群'}。
          {owner ? ' 配置完成后点击「启用项目」开始接单。' : ' 请联系 Owner 完成配置。'}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {!project.readiness.repo ? <Button size="sm" onClick={() => setTab('repo')}>去绑定仓库</Button> : null}
            {!project.readiness.channel ? <Button size="sm" onClick={() => setTab('channel')}>去绑定群</Button> : null}
          </div>
        </div>
      ) : null}

      {project.status === 'paused' ? (
        <div className="notice notice--warning" style={{ marginBottom: 16 }}>
          项目已暂停：不会创建或调度新工单，已排队/运行中的任务按策略处理。
        </div>
      ) : null}

      <div className="project-nav">
        <Tabs
          items={PRIMARY_TABS.map((key) => ({ key, label: TAB_LABELS[key] }))}
          value={activePrimary}
          onChange={setTab}
        />
        <MoreMenu items={visibleSecondary} activeTab={tab} onSelect={setTab} />
      </div>

      {tab === 'rooms' ? <RoomsTab {...tabProps} /> : null}
      {tab === 'roster' ? <RosterTab {...tabProps} /> : null}
      {tab === 'inbox' ? <InboxTab {...tabProps} /> : null}
      {tab === 'routines' ? <RoutinesTab {...tabProps} /> : null}
      {tab === 'connectors' ? <ConnectorsTab {...tabProps} /> : null}
      {tab === 'overview' ? <OverviewTab {...tabProps} /> : null}
      {tab === 'session' ? <MainSessionTab {...tabProps} /> : null}
      {tab === 'tickets' ? <TicketsTab {...tabProps} /> : null}
      {tab === 'members' ? <MembersTab {...tabProps} /> : null}
      {tab === 'channel' ? <ChannelTab {...tabProps} /> : null}
      {tab === 'repo' ? <RepoTab {...tabProps} /> : null}
      {tab === 'invites' ? <InvitesTab {...tabProps} /> : null}
      {tab === 'settings' ? <SettingsTab {...tabProps} /> : null}
      {tab === 'audit' ? <AuditTab {...tabProps} /> : null}
      {tab === 'usage' ? <UsageTab {...tabProps} /> : null}

      <p className="small muted" style={{ marginTop: 24 }}>
        项目 ID <code className="mono">{project.id}</code> · 创建于 {new Date(project.createdAt).toLocaleString('zh-CN')} ·{' '}
        <Link to="/">返回项目列表</Link>
      </p>
    </>
  )
}
