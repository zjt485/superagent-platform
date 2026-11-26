import { useState } from 'react'
import { api, ApiError, type ArtifactItem, type McpServer } from '../../api'
import { Badge, Button, Card, ConfirmButton, EmptyState, ErrorNotice, Modal, Spinner, useAsync, useToast } from '../../components'
import { relativeTime } from '../../format'
import { canMaintain, isOwner, type ProjectTabProps } from './types'

const POLICY_LABELS: Record<McpServer['defaultToolPolicy'], string> = {
  confirm: '写入/外发需确认（推荐）',
  confirm_all: '所有工具均需确认',
  allow: '全部自动放行',
  deny: '禁用调用',
}

export function ConnectorsTab({ project, role, refresh, onNavigate }: ProjectTabProps) {
  const { notify } = useToast()
  const mcpState = useAsync(() => api.mcp.list(project.id), [project.id])
  const artifactsState = useAsync(() => api.artifacts.list(project.id, 18), [project.id])
  const [error, setError] = useState<string | null>(null)
  const [localPath, setLocalPath] = useState('')
  const [localBranch, setLocalBranch] = useState('main')
  const [bindingLocal, setBindingLocal] = useState(false)
  const [discoveringId, setDiscoveringId] = useState<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpServer['transport']>('streamable_http')
  const [endpointOrCmd, setEndpointOrCmd] = useState('')
  const [argsText, setArgsText] = useState('')
  const [policy, setPolicy] = useState<McpServer['defaultToolPolicy']>('confirm')
  const [saving, setSaving] = useState(false)

  const editable = canMaintain(role)
  const owner = isOwner(role)
  const servers: McpServer[] = mcpState.data?.items ?? []
  const artifacts: ArtifactItem[] = artifactsState.data?.items ?? []

  const bindLocalRepo = async () => {
    if (!localPath.trim()) return
    setBindingLocal(true)
    setError(null)
    try {
      await api.repo.bindLocal(project.id, {
        path: localPath.trim(),
        defaultBranch: localBranch.trim() || 'main',
      })
      notify('已绑定本地 Git 仓库', 'success')
      setLocalPath('')
      refresh()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '绑定本地仓库失败')
    } finally {
      setBindingLocal(false)
    }
  }

  const createServer = async () => {
    if (!name.trim() || !endpointOrCmd.trim()) return
    setSaving(true)
    setError(null)
    try {
      const args = argsText
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
      await api.mcp.create(project.id, {
        name: name.trim(),
        transport,
        endpointOrCmd: endpointOrCmd.trim(),
        args,
        defaultToolPolicy: policy,
      })
      notify(`已添加 MCP 连接器「${name.trim()}」`, 'success')
      setCreateOpen(false)
      setName('')
      setEndpointOrCmd('')
      setArgsText('')
      mcpState.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建 MCP 服务器失败')
    } finally {
      setSaving(false)
    }
  }

  const discover = async (server: McpServer) => {
    setDiscoveringId(server.id)
    setError(null)
    try {
      const res = await api.mcp.discover(project.id, server.id)
      notify(`已从 ${server.name} 发现 ${res.tools.length} 个工具`, 'success')
      mcpState.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : `连接 ${server.name} 失败`)
    } finally {
      setDiscoveringId(null)
    }
  }

  const toggleServer = async (server: McpServer) => {
    setError(null)
    try {
      await api.mcp.update(project.id, server.id, { enabled: !server.enabled })
      notify(server.enabled ? `已停用 ${server.name}` : `已启用 ${server.name}`, 'success')
      mcpState.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '更新状态失败')
    }
  }

  const removeServer = async (server: McpServer) => {
    setError(null)
    try {
      await api.mcp.remove(project.id, server.id)
      notify(`已移除 ${server.name}`, 'success')
      mcpState.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '删除失败')
    }
  }

  return (
    <div className="stack">
      <ErrorNotice message={error} />

      <Card
        title="代码仓库连接器（可选）"
        extra={
          <Button size="sm" variant="subtle" onClick={() => onNavigate('repo')}>
            GitHub App 配置 →
          </Button>
        }
      >
        <p className="small muted" style={{ marginBottom: 12 }}>
          项目无需绑定代码仓库即可直接让研究员、PM 等 Bot 开始协作。需要工程师改代码并提 PR 时，可绑定 GitHub 仓库或本机 Git 目录。
        </p>
        {project.repo ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <Badge tone="success" label={project.repo.installationId === 'local' ? '本地 Git' : 'GitHub'} />
            <code className="mono">{project.repo.fullName}</code>
            <span className="small muted">默认分支：{project.repo.defaultBranch}</span>
          </div>
        ) : (
          <p className="small muted" style={{ marginBottom: 12 }}>
            当前未绑定代码仓库（Bot 将在独立沙箱目录内工作）。
          </p>
        )}

        {owner ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 260 }}
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder="本地 Git 仓库绝对路径，如 /srv/repos/app 或 D:\code\app"
            />
            <input
              className="input"
              style={{ width: 120 }}
              value={localBranch}
              onChange={(e) => setLocalBranch(e.target.value)}
              placeholder="main"
            />
            <Button size="sm" variant="primary" loading={bindingLocal} disabled={!localPath.trim()} onClick={bindLocalRepo}>
              绑定本地仓库
            </Button>
          </div>
        ) : null}
      </Card>

      <Card
        title="MCP 工具连接器（Model Context Protocol）"
        extra={
          editable ? (
            <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
              ＋ 添加 MCP 服务器
            </Button>
          ) : null
        }
      >
        <p className="small muted" style={{ marginBottom: 14 }}>
          接入外部 MCP 工具（如 Linear、Notion、Sentry、数据库只读查询、Slack 等）。点击「发现工具」后，项目内所有启用中的 Bot 会自动挂载对应工具，并遵守「Suggest, don&apos;t send」风险审批策略。
        </p>

        {mcpState.loading ? (
          <Spinner label="加载 MCP 服务器…" />
        ) : servers.length === 0 ? (
          <EmptyState
            title="还没有接入 MCP 服务器"
            hint="添加 Streamable HTTP / SSE 或本地 Stdio MCP 服务，让数字员工连接企业外部系统。"
          />
        ) : (
          <div className="bot-grid">
            {servers.map((server) => (
              <div key={server.id} className="bot-card">
                <div className="bot-card__head">
                  <div className="bot-card__avatar">🔌</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong>{server.name}</strong>
                      <Badge tone={server.enabled ? 'success' : 'neutral'} label={server.enabled ? '已启用' : '已停用'} />
                      <Badge tone="info" label={server.transport} />
                    </div>
                    <div className="mono small muted" style={{ marginTop: 2, wordBreak: 'break-all' }}>
                      {server.endpointOrCmd}
                      {server.args.length > 0 ? ` ${server.args.join(' ')}` : ''}
                    </div>
                  </div>
                </div>

                <div className="small muted">
                  策略：<strong>{POLICY_LABELS[server.defaultToolPolicy] ?? server.defaultToolPolicy}</strong>
                  {server.lastHealthAt ? ` · 最近同步 ${relativeTime(server.lastHealthAt)}` : ' · 尚未发现工具'}
                </div>

                {server.cachedTools.length > 0 ? (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {server.cachedTools.slice(0, 12).map((tool) => (
                      <Badge key={tool.name} tone="neutral" label={`mcp:${server.name}:${tool.name}`} />
                    ))}
                    {server.cachedTools.length > 12 ? (
                      <span className="small muted">+{server.cachedTools.length - 12} 个</span>
                    ) : null}
                  </div>
                ) : null}

                {editable ? (
                  <div className="bot-card__actions">
                    <Button size="sm" variant="primary" loading={discoveringId === server.id} onClick={() => discover(server)}>
                      发现工具
                    </Button>
                    <Button size="sm" variant="subtle" onClick={() => toggleServer(server)}>
                      {server.enabled ? '停用' : '启用'}
                    </Button>
                    <ConfirmButton
                      size="sm"
                      title="删除 MCP 连接器"
                      message={`确认移除 MCP 服务器「${server.name}」吗？`}
                      confirmLabel="删除"
                      danger
                      onConfirm={() => removeServer(server)}
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

      <Card title="沙箱与浏览器产物（Screenshots & Artifacts）">
        {artifactsState.loading ? (
          <Spinner label="加载产物…" />
        ) : artifacts.length === 0 ? (
          <EmptyState
            title="暂无浏览器截图或沙箱产物"
            hint="当 Bot 使用 browser_screenshot 抓取页面或导出报告时，产物会自动归档于此并在协作房间的实时围观面板展示。"
          />
        ) : (
          <div className="bot-grid">
            {artifacts.map((item) => {
              const url = api.artifacts.url(project.id, item.id)
              const isImage = item.mimeType.startsWith('image/')
              return (
                <a
                  key={item.id}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="bot-card"
                  style={{ textDecoration: 'none', color: 'inherit' }}
                >
                  {isImage ? (
                    <img
                      src={url}
                      alt={item.title}
                      style={{ width: '100%', maxHeight: 150, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }}
                    />
                  ) : null}
                  <div>
                    <strong style={{ display: 'block' }}>{item.title}</strong>
                    <span className="small muted">
                      {item.kind} · {(item.sizeBytes / 1024).toFixed(1)} KB · {relativeTime(item.createdAt)}
                    </span>
                  </div>
                </a>
              )
            })}
          </div>
        )}
      </Card>

      <Modal open={createOpen} title="添加 MCP 工具服务器" onClose={() => setCreateOpen(false)}>
        <div className="form-stack">
          <label className="field">
            <span className="field__label">名称（唯一标识，如 linear / sentry / docs）</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="linear" />
          </label>
          <label className="field">
            <span className="field__label">传输方式</span>
            <select
              className="input"
              value={transport}
              onChange={(e) => setTransport(e.target.value as McpServer['transport'])}
            >
              <option value="streamable_http">Streamable HTTP</option>
              <option value="sse">SSE</option>
              <option value="stdio">本地 Stdio 进程</option>
            </select>
          </label>
          <label className="field">
            <span className="field__label">{transport === 'stdio' ? '可执行命令（如 npx / node）' : '服务 Endpoint URL'}</span>
            <input
              className="input"
              value={endpointOrCmd}
              onChange={(e) => setEndpointOrCmd(e.target.value)}
              placeholder={transport === 'stdio' ? 'npx' : 'https://mcp.example.com/mcp'}
            />
          </label>
          {transport === 'stdio' ? (
            <label className="field">
              <span className="field__label">命令参数（空格分隔）</span>
              <input
                className="input"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-filesystem /workspace"
              />
            </label>
          ) : null}
          <label className="field">
            <span className="field__label">默认审批策略</span>
            <select
              className="input"
              value={policy}
              onChange={(e) => setPolicy(e.target.value as McpServer['defaultToolPolicy'])}
            >
              <option value="confirm">写入/外发需人工确认（推荐）</option>
              <option value="confirm_all">所有工具均需人工确认</option>
              <option value="allow">全部自动放行</option>
              <option value="deny">禁用调用</option>
            </select>
          </label>
          <div className="form-actions">
            <Button variant="subtle" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button variant="primary" loading={saving} disabled={!name.trim() || !endpointOrCmd.trim()} onClick={createServer}>
              保存连接器
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
