import { useState } from 'react'
import { api, ApiError, type Bot } from '../../api'
import { Badge, Button, Card, EmptyState, ErrorNotice, Modal, Spinner, useAsync, useToast } from '../../components'
import { relativeTime } from '../../format'
import { canMaintain, type ProjectTabProps } from './types'

export function RosterTab({ project, role, onNavigate }: ProjectTabProps) {
  const { notify } = useToast()
  const state = useAsync(() => api.bots.list(project.id), [project.id])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [roleTitle, setRoleTitle] = useState('')
  const [avatar, setAvatar] = useState('🤖')
  const [model, setModel] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [sandboxMode, setSandboxMode] = useState<'local' | 'docker'>('local')

  const editable = canMaintain(role)
  const bots: Bot[] = (state.data?.items ?? []).filter((b) => b.status !== 'archived')

  const installTemplate = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.bots.installRdTemplates(project.id)
      notify(`已导入 ${res.created.length} 个产研数字员工`, 'success')
      state.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '导入模板失败')
    } finally {
      setBusy(false)
    }
  }

  const createCustomBot = async () => {
    if (!name.trim() || !roleTitle.trim()) return
    setBusy(true)
    setError(null)
    try {
      await api.bots.create(project.id, {
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        roleTitle: roleTitle.trim(),
        avatar: avatar.trim() || '🤖',
        systemPrompt: systemPrompt.trim(),
        modelConfig: model.trim() ? { model: model.trim() } : {},
        sandboxConfig: { mode: sandboxMode, browserEnabled: true },
      })
      setCreateOpen(false)
      setName('')
      setSlug('')
      setRoleTitle('')
      setSystemPrompt('')
      setModel('')
      notify('已新增数字员工', 'success')
      state.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建 Bot 失败')
    } finally {
      setBusy(false)
    }
  }

  const togglePause = async (bot: Bot) => {
    try {
      await api.bots.update(project.id, bot.id, { status: bot.status === 'active' ? 'paused' : 'active' })
      notify(bot.status === 'active' ? `已暂停 @${bot.slug}` : `已启用 @${bot.slug}`, 'success')
      state.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '更新状态失败')
    }
  }

  const openDm = async (bot: Bot) => {
    try {
      await api.rooms.create(project.id, { kind: 'dm', defaultBotId: bot.id })
      onNavigate('rooms')
      notify(`已打开与 @${bot.slug} 的私聊`, 'success')
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '打开私聊失败')
    }
  }

  if (state.loading) {
    return (
      <Card>
        <Spinner label="正在加载 Bot 团队…" />
      </Card>
    )
  }

  return (
    <div className="stack">
      <Card
        title="Bot 团队花名册（Roster）"
        extra={
          editable ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant="subtle" loading={busy} onClick={installTemplate}>
                ⚡ 一键导入产研 4 人团队
              </Button>
              <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
                ＋ 新增 Bot
              </Button>
            </div>
          ) : null
        }
      >
        <p className="small muted" style={{ marginBottom: 14 }}>
          每个 Bot 拥有独立岗位人设、模型配置、工具风险策略与持久化沙箱环境，可在协作房间中通过 <code>@slug</code> 点名或互相 <code>handoff</code> 接力协作。
        </p>
        <ErrorNotice message={error} />

        {bots.length === 0 ? (
          <EmptyState
            title="还没有数字员工"
            hint="点击右上角「一键导入产研 4 人团队」快速获得 调研员、产品经理、全栈工程师、QA 巡检 四个预设 Bot。"
          />
        ) : (
          <div className="roster-grid">
            {bots.map((bot) => (
              <div key={bot.id} className="bot-card">
                <div className="bot-card__head">
                  <div className="bot-card__avatar">{bot.avatar ?? '🤖'}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong>{bot.name}</strong>
                      <code className="small muted">@{bot.slug}</code>
                    </div>
                    <div className="small muted">{bot.roleTitle}</div>
                  </div>
                  <Badge status={bot.status} label={bot.status === 'active' ? '在线' : '已暂停'} />
                </div>
                {bot.systemPrompt ? (
                  <p className="small muted bot-card__prompt">{bot.systemPrompt}</p>
                ) : null}
                <div className="bot-card__meta">
                  <span>模型：{bot.modelConfig.model ?? '项目默认'}</span>
                  <span>沙箱：{bot.sandboxConfig.mode ?? 'local'} ({bot.sandboxState})</span>
                  {bot.lastActiveAt ? <span>最近活跃：{relativeTime(bot.lastActiveAt)}</span> : null}
                </div>
                <div className="bot-card__actions">
                  <Button size="sm" variant="subtle" onClick={() => openDm(bot)}>
                    💬 私聊
                  </Button>
                  {editable ? (
                    <Button size="sm" variant="subtle" onClick={() => togglePause(bot)}>
                      {bot.status === 'active' ? '暂停' : '启用'}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal open={createOpen} title="新增数字员工 Bot" onClose={() => setCreateOpen(false)}>
        <div className="form-stack">
          <div className="form-row">
            <label className="field">
              <span className="field__label">名称</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：前端专家" />
            </label>
            <label className="field">
              <span className="field__label">@标识（slug，可选）</span>
              <input className="input" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="frontend" />
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              <span className="field__label">岗位角色</span>
              <input className="input" value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} placeholder="React / CSS 交互实现" />
            </label>
            <label className="field">
              <span className="field__label">头像 Emoji</span>
              <input className="input" value={avatar} onChange={(e) => setAvatar(e.target.value)} maxLength={8} />
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              <span className="field__label">独立模型（留空使用平台默认）</span>
              <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
            </label>
            <label className="field">
              <span className="field__label">执行沙箱模式</span>
              <select className="select" value={sandboxMode} onChange={(e) => setSandboxMode(e.target.value as 'local' | 'docker')}>
                <option value="local">本地隔离目录（开发/轻量）</option>
                <option value="docker">每 Bot 持久化 Docker 容器</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span className="field__label">人设与职责 Prompt</span>
            <textarea className="textarea" rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="说明岗位职责、擅长工具以及何时 handoff 给其他同事…" />
          </label>
          <div className="form-actions">
            <Button variant="subtle" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button variant="primary" loading={busy} disabled={!name.trim() || !roleTitle.trim()} onClick={createCustomBot}>创建 Bot</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
