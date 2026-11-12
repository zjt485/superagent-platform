import { useState } from 'react'
import { api, ApiError, type ChannelProvider } from '../../api'
import { Badge, Button, Card, ConfirmButton, EmptyState, ErrorNotice, ErrorState, Field, Spinner, useAsync, useToast } from '../../components'
import { PROVIDER_LABELS, formatDate } from '../../format'
import type { ProjectTabProps } from './types'
import { isOwner } from './types'

export function ChannelTab({ project, role }: ProjectTabProps) {
  const owner = isOwner(role)
  const { notify } = useToast()
  const state = useAsync(() => api.channels.list(project.id), [project.id])
  const [provider, setProvider] = useState<ChannelProvider>('feishu')
  const [chatId, setChatId] = useState('')
  const [name, setName] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const items = state.data?.items ?? []
  const active = items.find((channel) => channel.status === 'active')

  const bind = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.channels.bind(project.id, {
        provider,
        externalChatId: chatId.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(provider === 'wecom' && webhookUrl.trim() ? { config: { webhookUrl: webhookUrl.trim() } } : {}),
      })
      notify('群绑定成功', 'success')
      setChatId('')
      setName('')
      setWebhookUrl('')
      state.reload()
      window.dispatchEvent(new Event('projects:changed'))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '绑定失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <Card
        title="当前绑定"
        extra={active ? <Badge status="active" label="已绑定" /> : <Badge tone="warning" label="未绑定" />}
      >
        {state.loading ? <Spinner label="正在加载绑定…" /> : null}
        {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !active ? (
          <EmptyState title="尚未绑定 IM 群" hint="一个项目绑定一个主群。也可以让 Owner 在群里发送 @bot /bind <项目标识> 完成绑定。" />
        ) : null}
        {active ? (
          <div className="stack">
            <dl className="kv-list">
              <div>
                <dt>平台</dt>
                <dd>{PROVIDER_LABELS[active.provider] ?? active.provider}</dd>
              </div>
              <div>
                <dt>群名称</dt>
                <dd>{active.name ?? '—'}</dd>
              </div>
              <div>
                <dt>Chat ID</dt>
                <dd>
                  <code className="mono">{active.externalChatId}</code>
                </dd>
              </div>
              <div>
                <dt>绑定时间</dt>
                <dd>{formatDate(active.createdAt)}</dd>
              </div>
            </dl>
            {owner ? (
              <div className="form-actions">
                <ConfirmButton
                  title="解绑 IM 群"
                  message="解绑后该群消息不再进入项目，已有工单保留。确定解绑？"
                  confirmLabel="解绑"
                  danger
                  onConfirm={async () => {
                    try {
                      await api.channels.unbind(project.id, active.id)
                      notify('已解绑', 'success')
                      state.reload()
                      window.dispatchEvent(new Event('projects:changed'))
                    } catch (cause) {
                      notify(cause instanceof ApiError ? cause.message : '解绑失败', 'danger')
                    }
                  }}
                >
                  解绑群
                </ConfirmButton>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      <div className="grid grid--2">
        <Card title="绑定一个新的群">
          <div className="form-stack">
            <Field label="IM 平台">
              <select className="select" value={provider} onChange={(event) => setProvider(event.target.value as ChannelProvider)}>
                <option value="feishu">飞书</option>
                <option value="wecom">企业微信</option>
              </select>
            </Field>
            <Field label="群 Chat ID" hint={provider === 'feishu' ? '飞书群设置中可复制 chat_id，或由机器人收到的回调里获取。' : '企业微信群 chatid；若使用群机器人 Webhook，可只填群标识并配置 Webhook 地址。'}>
              <input className="input" value={chatId} onChange={(event) => setChatId(event.target.value)} placeholder={provider === 'feishu' ? 'oc_xxxxxxxx' : 'oc_xxxxxxxx'} />
            </Field>
            <Field label="备注名称（可选）">
              <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：增长项目群" />
            </Field>
            {provider === 'wecom' ? (
              <Field label="群机器人 Webhook（可选）" hint="企业微信应用消息无法直接发到已有群时，可配置群机器人 Webhook 作为发送通道。">
                <input className="input" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." />
              </Field>
            ) : null}
            <ErrorNotice message={error} />
            <div className="form-actions">
              <Button variant="primary" onClick={bind} loading={busy} disabled={!owner || !chatId.trim()}>
                绑定群
              </Button>
            </div>
            {!owner ? <p className="small muted">只有项目 Owner 可以绑定或解绑群。</p> : null}
          </div>
        </Card>

        <Card title="接入说明">
          <ol className="small muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
            <li>在飞书 / 企业微信创建应用与机器人，把回调地址配置为 <code className="mono">/webhooks/{provider}</code>。</li>
            <li>把机器人拉进项目群，给机器人开通读取群消息、发送消息的权限。</li>
            <li>在控制台绑定群，或让 Owner 在群里发送 <code className="mono">@bot /bind {project.slug}</code>。</li>
            <li>项目启用后，群成员 @bot 即可建单；工单线程内的回复默认免 @。</li>
          </ol>
          <div className="notice notice--info" style={{ marginTop: 14 }}>
            平台不会监听普通群聊：非 @ 消息、非项目群消息一律忽略；只有已建工单线程内的回复会追加到工单。
          </div>
        </Card>
      </div>

      {items.length > 1 ? (
        <Card title="历史绑定">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>平台</th>
                  <th>群</th>
                  <th>状态</th>
                  <th>绑定时间</th>
                </tr>
              </thead>
              <tbody>
                {items.map((channel) => (
                  <tr key={channel.id}>
                    <td>{PROVIDER_LABELS[channel.provider] ?? channel.provider}</td>
                    <td>{channel.name ?? channel.externalChatId}</td>
                    <td>
                      <Badge status={channel.status === 'active' ? 'active' : 'neutral'} label={channel.status === 'active' ? '使用中' : '已停用'} />
                    </td>
                    <td className="small muted">{formatDate(channel.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  )
}
