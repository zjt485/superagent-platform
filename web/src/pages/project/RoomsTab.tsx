import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, subscribeProjectEvents, type Room, type RoomMessage } from '../../api'
import { Badge, Button, Card, EmptyState, ErrorNotice, Modal, Spinner, useAsync, useToast } from '../../components'
import { relativeTime } from '../../format'
import type { ProjectTabProps } from './types'

interface LiveEventItem {
  id: string
  type: string
  message: string
  at: string
  screenshotUrl?: string
}

export function RoomsTab({ project, onNavigate }: ProjectTabProps) {
  const { notify } = useToast()
  const roomsState = useAsync(() => api.rooms.list(project.id), [project.id])
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null)
  const [messages, setMessages] = useState<RoomMessage[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [composer, setComposer] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [liveEvents, setLiveEvents] = useState<LiveEventItem[]>([])
  const [workingBots, setWorkingBots] = useState<Record<string, boolean>>({})
  const [newRoomOpen, setNewRoomOpen] = useState(false)
  const [newRoomName, setNewRoomName] = useState('')
  const [newRoomTopic, setNewRoomTopic] = useState('')
  const endRef = useRef<HTMLDivElement | null>(null)

  const rooms: Room[] = roomsState.data?.items ?? []
  const activeRoom = rooms.find((r) => r.id === selectedRoomId) ?? rooms[0] ?? null

  useEffect(() => {
    if (!selectedRoomId && rooms[0]) setSelectedRoomId(rooms[0].id)
  }, [rooms, selectedRoomId])

  useEffect(() => {
    if (!activeRoom) return
    let alive = true
    setLoadingMessages(true)
    api.rooms
      .messages(project.id, activeRoom.id)
      .then((res) => {
        if (alive) setMessages(res.items)
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof ApiError ? cause.message : '加载消息失败')
      })
      .finally(() => alive && setLoadingMessages(false))
    return () => {
      alive = false
    }
  }, [project.id, activeRoom?.id])

  useEffect(() => {
    const unsub = subscribeProjectEvents(project.id, (event) => {
      if (event.type === 'room.message') {
        const msg = event.data.message as RoomMessage | undefined
        if (msg && msg.roomId === activeRoom?.id) {
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]))
        }
        roomsState.reload()
      } else if (event.type === 'bot.status') {
        const botId = String(event.data.botId ?? '')
        const state = String(event.data.state ?? 'idle')
        if (botId) setWorkingBots((prev) => ({ ...prev, [botId]: state === 'working' }))
      } else if (event.type === 'turn.event') {
        const payload = (event.data.payload ?? {}) as Record<string, unknown>
        const screenshotUrl = typeof payload.screenshotUrl === 'string' ? payload.screenshotUrl : undefined
        const item: LiveEventItem = {
          id: `${event.timestamp}-${Math.random().toString(36).slice(2, 7)}`,
          type: String(event.data.type ?? 'event'),
          message: String(event.data.message ?? ''),
          at: event.timestamp,
          ...(screenshotUrl ? { screenshotUrl } : {}),
        }
        setLiveEvents((prev) => [item, ...prev].slice(0, 60))
      }
    })
    return unsub
  }, [project.id, activeRoom?.id])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  const sendMessage = async () => {
    if (!activeRoom || !composer.trim() || sending) return
    setSending(true)
    setError(null)
    try {
      const res = await api.rooms.postMessage(project.id, activeRoom.id, { content: composer.trim() })
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]))
      setComposer('')
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  const createGroupRoom = async () => {
    if (!newRoomName.trim()) return
    try {
      const res = await api.rooms.create(project.id, {
        kind: 'group',
        name: newRoomName.trim(),
        topic: newRoomTopic.trim() || undefined,
      })
      setNewRoomOpen(false)
      setNewRoomName('')
      setNewRoomTopic('')
      setSelectedRoomId(res.room.id)
      roomsState.reload()
      notify(`已创建协作房间「${res.room.name}」`, 'success')
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建房间失败')
    }
  }

  if (roomsState.loading && rooms.length === 0) {
    return (
      <Card>
        <Spinner label="正在加载协作房间…" />
      </Card>
    )
  }

  return (
    <div className="rooms-layout">
      <aside className="rooms-sidebar">
        <div className="rooms-sidebar__head">
          <strong>协作房间</strong>
          <Button size="sm" variant="subtle" onClick={() => setNewRoomOpen(true)}>
            ＋ 新建
          </Button>
        </div>
        <div className="rooms-list">
          {rooms.map((room) => (
            <button
              key={room.id}
              type="button"
              className={`room-item ${activeRoom?.id === room.id ? 'room-item--active' : ''}`}
              onClick={() => setSelectedRoomId(room.id)}
            >
              <div className="room-item__top">
                <span className="room-item__name">
                  {room.kind === 'dm' ? '💬 ' : room.kind === 'routine_feed' ? '⏰ ' : '# '}
                  {room.name}
                </span>
                {room.channelId ? <Badge tone="info" label="IM同步" /> : null}
              </div>
              <div className="room-item__meta">
                <span>{room.bots.length} 个 Bot</span>
                {room.lastMessage ? <span> · {relativeTime(room.lastMessage.createdAt)}</span> : null}
              </div>
              {room.lastMessage ? <p className="room-item__preview">{room.lastMessage.authorName}: {room.lastMessage.content}</p> : null}
            </button>
          ))}
        </div>
        <div className="rooms-sidebar__foot">
          <Button size="sm" variant="subtle" onClick={() => onNavigate('roster')} style={{ width: '100%' }}>
            管理 Bot 团队 →
          </Button>
        </div>
      </aside>

      <section className="rooms-main">
        {!activeRoom ? (
          <EmptyState title="还没有协作房间" hint="新建一个群聊或去 Bot 团队发起私聊。" />
        ) : (
          <>
            <header className="rooms-main__head">
              <div>
                <strong>{activeRoom.name}</strong>
                {activeRoom.topic ? <span className="small muted" style={{ marginLeft: 8 }}>{activeRoom.topic}</span> : null}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="small muted">最大接力 {activeRoom.maxHandoffHops} 跳</span>
                <Button size="sm" variant="subtle" onClick={() => setInspectorOpen((v) => !v)}>
                  {inspectorOpen ? '收起围观' : '打开围观'}
                </Button>
              </div>
            </header>

            <div className="rooms-bots-bar">
              {activeRoom.bots.length === 0 ? (
                <span className="small muted">
                  当前房间还没有数字员工。
                  <button type="button" className="link-btn" onClick={() => onNavigate('roster')}>
                    去 Bot 团队一键导入产研模板
                  </button>
                </span>
              ) : (
                activeRoom.bots.map((bot) => (
                  <button
                    key={bot.id}
                    type="button"
                    className={`bot-pill ${workingBots[bot.id] ? 'bot-pill--working' : ''}`}
                    title={`点击插入 @${bot.slug}（${bot.roleTitle}）`}
                    onClick={() => setComposer((prev) => `${prev ? `${prev} ` : ''}@${bot.slug} `)}
                  >
                    <span>{bot.avatar ?? '🤖'}</span>
                    <span>@{bot.slug}</span>
                    <span className="small muted">{bot.roleTitle}</span>
                  </button>
                ))
              )}
            </div>

            <ErrorNotice message={error} />

            <div className="rooms-messages">
              {loadingMessages ? (
                <Spinner label="加载消息…" />
              ) : messages.length === 0 ? (
                <EmptyState
                  title="开始在房间里委派任务"
                  hint="点击上方 @Bot 快捷标签点名，或直接描述需求由 Router 自动分派并触发多 Bot 接力协作。"
                />
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className={`room-msg room-msg--${msg.kind} room-msg--${msg.authorKind}`}>
                    <div className="room-msg__avatar">{msg.authorAvatar ?? msg.authorName.slice(0, 1).toUpperCase()}</div>
                    <div className="room-msg__body">
                      <div className="room-msg__head">
                        <strong>{msg.authorName}</strong>
                        {msg.botRoleTitle ? <Badge tone="neutral" label={msg.botRoleTitle} /> : null}
                        {msg.kind === 'handoff' ? <Badge tone="info" label="交接 Handoff" /> : null}
                        {msg.kind === 'approval_card' ? <Badge tone="warning" label="待审批" /> : null}
                        {msg.ticketId ? (
                          <Link className="small mono" to={`/projects/${project.id}/tickets/${msg.ticketId}`}>
                            #{msg.ticketShortName ?? msg.ticketId.slice(0, 8)}
                          </Link>
                        ) : null}
                        <span className="small muted">{relativeTime(msg.createdAt)}</span>
                      </div>
                      <div className="room-msg__content">{msg.content}</div>
                      {msg.attachments.length > 0 ? (
                        <div className="room-msg__attachments">
                          {msg.attachments.map((att, idx) =>
                            att.type === 'screenshot' && att.url ? (
                              <a key={idx} href={att.url} target="_blank" rel="noreferrer" className="room-screenshot">
                                <img src={att.url} alt={att.title} />
                                <span>{att.title}</span>
                              </a>
                            ) : att.url ? (
                              <a key={idx} href={att.url} target="_blank" rel="noreferrer" className="badge badge--info">
                                📎 {att.title}
                              </a>
                            ) : null,
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
              <div ref={endRef} />
            </div>

            <div className="rooms-composer">
              <textarea
                className="textarea"
                rows={2}
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void sendMessage()
                  }
                }}
                placeholder="输入需求，支持 @researcher / @pm / @engineer / @qa 点名，或 /status /approve /cancel…"
              />
              <Button variant="primary" loading={sending} disabled={!composer.trim()} onClick={sendMessage}>
                发送
              </Button>
            </div>
          </>
        )}
      </section>

      {inspectorOpen ? (
        <aside className="rooms-inspector">
          <div className="rooms-inspector__head">
            <strong>实时围观（SSE）</strong>
            <span className="small muted">{liveEvents.length} 条</span>
          </div>
          {liveEvents.length === 0 ? (
            <p className="small muted" style={{ padding: 12 }}>
              Bot 开始执行后，这里的实时流会展示工具调用、终端日志与浏览器截图。
            </p>
          ) : (
            <div className="inspector-feed">
              {liveEvents.map((ev) => (
                <div key={ev.id} className="inspector-item">
                  <div className="inspector-item__head">
                    <Badge tone={ev.type === 'handoff' ? 'info' : ev.type === 'error' ? 'danger' : 'neutral'} label={ev.type} />
                    <span className="small muted">{relativeTime(ev.at)}</span>
                  </div>
                  {ev.message ? <div className="mono small" style={{ marginTop: 4, wordBreak: 'break-word' }}>{ev.message}</div> : null}
                  {ev.screenshotUrl ? (
                    <a href={ev.screenshotUrl} target="_blank" rel="noreferrer" className="room-screenshot" style={{ marginTop: 6 }}>
                      <img src={ev.screenshotUrl} alt="实时截图" />
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </aside>
      ) : null}

      <Modal open={newRoomOpen} title="新建协作房间" onClose={() => setNewRoomOpen(false)}>
        <div className="form-stack">
          <label className="field">
            <span className="field__label">房间名称</span>
            <input className="input" value={newRoomName} onChange={(e) => setNewRoomName(e.target.value)} placeholder="例如：登录改版专项群" />
          </label>
          <label className="field">
            <span className="field__label">主题说明（可选）</span>
            <input className="input" value={newRoomTopic} onChange={(e) => setNewRoomTopic(e.target.value)} placeholder="负责登录体验调研、改版与 QA 回归" />
          </label>
          <div className="form-actions">
            <Button variant="subtle" onClick={() => setNewRoomOpen(false)}>取消</Button>
            <Button variant="primary" disabled={!newRoomName.trim()} onClick={createGroupRoom}>创建房间</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
