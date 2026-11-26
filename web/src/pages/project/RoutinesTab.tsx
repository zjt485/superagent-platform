import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, subscribeProjectEvents, type Bot, type Room, type Routine } from '../../api'
import { Badge, Button, Card, ConfirmButton, EmptyState, ErrorNotice, Modal, Spinner, useAsync, useToast } from '../../components'
import { relativeTime } from '../../format'
import { canMaintain, type ProjectTabProps } from './types'

const CRON_PRESETS = [
  { label: '每 15 分钟', expr: '*/15 * * * *' },
  { label: '每小时整点', expr: '0 * * * *' },
  { label: '每天 09:00', expr: '0 9 * * *' },
  { label: '工作日 09:30', expr: '30 9 * * 1-5' },
  { label: '每周一 10:00', expr: '0 10 * * 1' },
]

export function RoutinesTab({ project, role }: ProjectTabProps) {
  const { notify } = useToast()
  const routinesState = useAsync(() => api.routines.list(project.id), [project.id])
  const botsState = useAsync(() => api.bots.list(project.id), [project.id])
  const roomsState = useAsync(() => api.rooms.list(project.id), [project.id])

  const [error, setError] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [triggerType, setTriggerType] = useState<Routine['triggerType']>('cron')
  const [cronExpr, setCronExpr] = useState('0 9 * * 1-5')
  const [timezone, setTimezone] = useState('Asia/Shanghai')
  const [eventList, setEventList] = useState('push, pull_request')
  const [branchList, setBranchList] = useState('main')
  const [botId, setBotId] = useState('')
  const [roomId, setRoomId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [notifyOnQuiet, setNotifyOnQuiet] = useState(false)

  const editable = canMaintain(role)
  const items: Routine[] = routinesState.data?.items ?? []
  const bots: Bot[] = (botsState.data?.items ?? []).filter((b) => b.status === 'active')
  const rooms: Room[] = roomsState.data?.items ?? []

  useEffect(() => {
    const unsub = subscribeProjectEvents(project.id, (ev) => {
      if (ev.type === 'routine.run' || ev.type === 'ticket.updated') {
        routinesState.reload()
      }
    })
    return unsub
  }, [project.id])

  const createRoutine = async () => {
    if (!name.trim() || !prompt.trim()) return
    setSaving(true)
    setError(null)
    try {
      const events = eventList
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const branches = branchList
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      await api.routines.create(project.id, {
        name: name.trim(),
        description: description.trim() || null,
        triggerType,
        cronExpr: triggerType === 'cron' ? cronExpr.trim() : null,
        timezone: timezone.trim() || 'Asia/Shanghai',
        eventFilter: triggerType === 'cron' ? {} : { events, branches },
        botId: botId || null,
        roomId: roomId || null,
        prompt: prompt.trim(),
        notifyOnQuiet,
      })
      notify(`已创建 7×24 巡检任务「${name.trim()}」`, 'success')
      setModalOpen(false)
      setName('')
      setDescription('')
      setPrompt('')
      routinesState.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建巡检任务失败')
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = async (item: Routine) => {
    setError(null)
    try {
      await api.routines.update(project.id, item.id, { enabled: !item.enabled })
      notify(item.enabled ? `已暂停「${item.name}」` : `已启用「${item.name}」`, 'success')
      routinesState.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '切换状态失败')
    }
  }

  const runNow = async (item: Routine) => {
    setRunningId(item.id)
    setError(null)
    try {
      await api.routines.runNow(project.id, item.id)
      notify(`已触发「${item.name}」立即执行`, 'success')
      routinesState.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '试跑失败')
    } finally {
      setRunningId(null)
    }
  }

  const removeItem = async (item: Routine) => {
    setError(null)
    try {
      await api.routines.remove(project.id, item.id)
      notify(`已删除「${item.name}」`, 'success')
      routinesState.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '删除失败')
    }
  }

  return (
    <div className="stack">
      <Card
        title="7×24 定时与事件巡检（Routines）"
        extra={
          editable ? (
            <Button size="sm" variant="primary" onClick={() => setModalOpen(true)}>
              ＋ 新建巡检任务
            </Button>
          ) : null
        }
      >
        <p className="small muted" style={{ marginBottom: 14 }}>
          配置 Cron 定时巡检或仓库 Push/PR 事件触发，让指定数字员工（如 @qa、@researcher）在后台主动巡检。默认开启「无事不扰」策略：一切正常时仅静默归档，发现异常或生成 PR 时再推送 IM 提醒。
        </p>
        <ErrorNotice message={error} />

        {routinesState.loading ? (
          <Spinner label="加载巡检任务…" />
        ) : items.length === 0 ? (
          <EmptyState
            title="还没有配置定时巡检任务"
            hint="例如：每天 09:00 让 @qa 跑核心回归并检查依赖安全；或每次 push 到 main 后自动巡检接口变更。"
          />
        ) : (
          <div className="bot-grid">
            {items.map((item) => (
              <div key={item.id} className="bot-card">
                <div className="bot-card__head">
                  <div className="bot-card__avatar">{item.botAvatar ?? '⏰'}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong>{item.name}</strong>
                      <Badge tone={item.enabled ? 'success' : 'neutral'} label={item.enabled ? '运行中' : '已暂停'} />
                      <Badge
                        tone="info"
                        label={
                          item.triggerType === 'cron'
                            ? `Cron ${item.cronExpr ?? ''}`
                            : item.triggerType === 'repo_event'
                              ? '仓库事件'
                              : 'Webhook'
                        }
                      />
                      {!item.notifyOnQuiet ? <Badge tone="neutral" label="无事不扰" /> : null}
                    </div>
                    <div className="small muted" style={{ marginTop: 2 }}>
                      执行者：{item.botName ? `${item.botName} (@${item.botSlug})` : 'Router 自动指派'}
                      {item.roomName ? ` · 汇报至 #${item.roomName}` : ''}
                    </div>
                  </div>
                </div>

                {item.description ? <p className="small">{item.description}</p> : null}
                <p className="small muted" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                  {item.prompt.length > 160 ? `${item.prompt.slice(0, 160)}…` : item.prompt}
                </p>

                <div className="small muted" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {item.nextRunAt ? (
                    <span>下次触发：{new Date(item.nextRunAt).toLocaleString('zh-CN')}</span>
                  ) : null}
                  {item.lastRunAt ? (
                    <span>
                      最近运行：{relativeTime(item.lastRunAt)}（{item.lastStatus ?? '已提交'}）
                    </span>
                  ) : (
                    <span>尚未运行</span>
                  )}
                  {item.lastTicketId ? (
                    <Link to={`/projects/${project.id}/tickets/${item.lastTicketId}`}>查看最近工单 →</Link>
                  ) : null}
                </div>

                {editable ? (
                  <div className="bot-card__actions">
                    <Button size="sm" variant="primary" loading={runningId === item.id} onClick={() => runNow(item)}>
                      立即试跑
                    </Button>
                    <Button size="sm" variant="subtle" onClick={() => toggleEnabled(item)}>
                      {item.enabled ? '暂停' : '启用'}
                    </Button>
                    <ConfirmButton
                      size="sm"
                      title="删除巡检任务"
                      message={`确认删除定时巡检「${item.name}」吗？`}
                      confirmLabel="删除"
                      danger
                      onConfirm={() => removeItem(item)}
                    >
                      删除
                    </ConfirmButton>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal open={modalOpen} title="新建 7×24 巡检任务" onClose={() => setModalOpen(false)}>
        <div className="form-stack">
          <label className="field">
            <span className="field__label">任务名称</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：每日 09:00 QA 回归与依赖巡检"
            />
          </label>
          <label className="field">
            <span className="field__label">简短说明（可选）</span>
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="检查核心测试、安全告警与竞品变更"
            />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label className="field">
              <span className="field__label">触发方式</span>
              <select
                className="input"
                value={triggerType}
                onChange={(e) => setTriggerType(e.target.value as Routine['triggerType'])}
              >
                <option value="cron">Cron 定时触发</option>
                <option value="repo_event">仓库事件（Push / PR）</option>
                <option value="webhook">外部 Webhook</option>
              </select>
            </label>
            <label className="field">
              <span className="field__label">负责 Bot</span>
              <select className="input" value={botId} onChange={(e) => setBotId(e.target.value)}>
                <option value="">Router 自动选择</option>
                {bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.avatar ?? '🤖'} {bot.name} (@{bot.slug})
                  </option>
                ))}
              </select>
            </label>
          </div>

          {triggerType === 'cron' ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                <label className="field">
                  <span className="field__label">Cron 表达式（5 段：分 时 日 月 周）</span>
                  <input className="input mono" value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} />
                </label>
                <label className="field">
                  <span className="field__label">时区</span>
                  <input className="input mono" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
                </label>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {CRON_PRESETS.map((preset) => (
                  <Button key={preset.expr} size="sm" variant="subtle" onClick={() => setCronExpr(preset.expr)}>
                    {preset.label}
                  </Button>
                ))}
              </div>
            </>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label className="field">
                <span className="field__label">监听事件（逗号分隔）</span>
                <input className="input mono" value={eventList} onChange={(e) => setEventList(e.target.value)} />
              </label>
              <label className="field">
                <span className="field__label">分支过滤（留空表示全部）</span>
                <input className="input mono" value={branchList} onChange={(e) => setBranchList(e.target.value)} />
              </label>
            </div>
          )}

          <label className="field">
            <span className="field__label">汇报房间</span>
            <select className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">默认项目主群</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">巡检指令 Prompt</span>
            <textarea
              className="textarea"
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="请检查最新提交的测试状态与构建健康度；如发现失败用例请定位根因并 @engineer 修复。"
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={notifyOnQuiet} onChange={(e) => setNotifyOnQuiet(e.target.checked)} />
            <span>即使「一切正常」也推送 IM 通知（默认关闭，仅异常时打扰）</span>
          </label>

          <div className="form-actions">
            <Button variant="subtle" onClick={() => setModalOpen(false)}>取消</Button>
            <Button variant="primary" loading={saving} disabled={!name.trim() || !prompt.trim()} onClick={createRoutine}>
              创建任务
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
