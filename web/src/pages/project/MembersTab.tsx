import { useState } from 'react'
import { api, ApiError, type Member } from '../../api'
import { Avatar, Badge, Button, Card, ConfirmButton, EmptyState, ErrorNotice, ErrorState, Field, Icon, Modal, RoleBadge, Spinner, useAsync, useToast } from '../../components'
import { ROLE_LABELS, formatDate } from '../../format'
import type { ProjectTabProps } from './types'
import { isOwner } from './types'

export function MembersTab({ project, role }: ProjectTabProps) {
  const { notify } = useToast()
  const state = useAsync(() => api.members.list(project.id), [project.id])
  const owner = isOwner(role)
  const [modalOpen, setModalOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<{ id: string; name: string; email: string | null }[]>([])
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null)
  const [newRole, setNewRole] = useState('member')
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const items = state.data?.items ?? []

  const searchUsers = async () => {
    if (!search.trim()) return
    setSearching(true)
    setError(null)
    try {
      const result = await api.users.search(search.trim())
      setResults(result.items)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '搜索失败')
    } finally {
      setSearching(false)
    }
  }

  const add = async () => {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.members.add(project.id, { userId: selected.id, role: newRole })
      state.reload()
      setModalOpen(false)
      setSelected(null)
      setResults([])
      setSearch('')
      notify(`已添加 ${result.items.find((member) => member.userId === selected.id)?.name ?? selected.name}`, 'success')
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '添加失败')
    } finally {
      setBusy(false)
    }
  }

  const changeRole = async (member: Member, nextRole: string) => {
    try {
      await api.members.updateRole(project.id, member.userId, nextRole)
      notify('角色已更新', 'success')
      state.reload()
    } catch (cause) {
      notify(cause instanceof ApiError ? cause.message : '角色更新失败', 'danger')
    }
  }

  return (
    <>
      <div className="filters">
        <span className="small muted">
          {items.length} 名成员 · Owner {items.filter((member) => member.role === 'owner').length} 人
        </span>
        <div className="filters__spacer" />
        <Button variant="primary" size="sm" onClick={() => setModalOpen(true)} disabled={!owner}>
          <Icon name="plus" size={14} />
          添加成员
        </Button>
      </div>

      <Card>
        {state.loading ? <Spinner label="正在加载成员…" /> : null}
        {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !state.error && items.length === 0 ? <EmptyState title="还没有成员" /> : null}
        {items.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>成员</th>
                  <th>IM 身份</th>
                  <th>角色</th>
                  <th>加入时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((member) => (
                  <tr key={member.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Avatar name={member.name} size="sm" />
                        <div className="table__title" style={{ minWidth: 0 }}>
                          <strong>{member.name}</strong>
                          <span>{member.userId.slice(0, 8)}</span>
                        </div>
                      </div>
                    </td>
                    <td className="small muted">{member.identities ?? '—'}</td>
                    <td>
                      {owner && member.role !== 'owner' ? (
                        <select className="select" value={member.role} onChange={(event) => void changeRole(member, event.target.value)} style={{ minWidth: 120, minHeight: 30 }}>
                          {(['maintainer', 'member', 'viewer'] as const).map((value) => (
                            <option key={value} value={value}>
                              {ROLE_LABELS[value]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <RoleBadge role={member.role} />
                      )}
                    </td>
                    <td className="small muted">{formatDate(member.joinedAt)}</td>
                    <td className="table__actions">
                      {owner && member.role !== 'owner' ? (
                        <ConfirmButton
                          size="sm"
                          variant="danger"
                          title="移除成员"
                          message={`确定将 ${member.name} 移出项目？对方将无法再查看项目数据。`}
                          confirmLabel="移除"
                          danger
                          onConfirm={async () => {
                            try {
                              await api.members.remove(project.id, member.userId)
                              notify('成员已移除', 'success')
                              state.reload()
                            } catch (cause) {
                              notify(cause instanceof ApiError ? cause.message : '移除失败', 'danger')
                            }
                          }}
                        >
                          移除
                        </ConfirmButton>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      {!owner ? (
        <p className="small muted" style={{ marginTop: 12 }}>
          <Badge tone="neutral" label={ROLE_LABELS[role] ?? role} /> 只有 Owner 可以添加成员或修改角色。
        </p>
      ) : null}

      <Modal
        open={modalOpen}
        title="添加项目成员"
        onClose={() => !busy && setModalOpen(false)}
        footer={
          <>
            <Button onClick={() => setModalOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" onClick={add} loading={busy} disabled={!selected}>
              添加
            </Button>
          </>
        }
      >
        <div className="form-stack">
          <div className="notice notice--info">
            对方需要先通过飞书 / 企业微信登录过一次平台（例如打开邀请链接），才能被搜索到。
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="input"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void searchUsers()}
              placeholder="按昵称或邮箱搜索"
            />
            <Button size="sm" onClick={searchUsers} loading={searching}>
              搜索
            </Button>
          </div>
          {results.length > 0 ? (
            <div className="run-list">
              {results.map((user) => (
                <button
                  key={user.id}
                  className="readiness__item"
                  onClick={() => setSelected({ id: user.id, name: user.name })}
                  style={{ textAlign: 'left', borderColor: selected?.id === user.id ? 'var(--brand)' : undefined }}
                >
                  <Avatar name={user.name} size="sm" />
                  <span className="readiness__text">
                    <strong>{user.name}</strong>
                    <span>{user.email ?? user.id.slice(0, 8)}</span>
                  </span>
                  {selected?.id === user.id ? <Badge tone="brand" label="已选择" /> : null}
                </button>
              ))}
            </div>
          ) : null}
          <Field label="角色">
            <select className="select" value={newRole} onChange={(event) => setNewRole(event.target.value)}>
              <option value="maintainer">Maintainer · 审批、取消、重试、评审</option>
              <option value="member">Member · 提需求、追问、查看</option>
              <option value="viewer">Viewer · 只读</option>
            </select>
          </Field>
          <ErrorNotice message={error} />
        </div>
      </Modal>
    </>
  )
}
