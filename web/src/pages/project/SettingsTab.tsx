import { useState } from 'react'
import { api, ApiError, type ModelConfig, type Policy } from '../../api'
import { Button, Card, ErrorNotice, Field, useToast } from '../../components'
import type { ProjectTabProps } from './types'
import { isOwner } from './types'

interface FormState {
  name: string
  description: string
  policy: Policy
  model: ModelConfig
}

export function SettingsTab({ project, role, refresh }: ProjectTabProps) {
  const owner = isOwner(role)
  const { notify } = useToast()
  const [form, setForm] = useState<FormState>({
    name: project.name,
    description: project.description ?? '',
    policy: { ...project.policyJson },
    model: { ...project.modelConfig },
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const updatePolicy = <K extends keyof Policy>(key: K, value: Policy[K]) =>
    setForm((current) => ({ ...current, policy: { ...current.policy, [key]: value } }))
  const updateModel = <K extends keyof ModelConfig>(key: K, value: ModelConfig[K]) =>
    setForm((current) => ({ ...current, model: { ...current.model, [key]: value } }))

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.projects.update(project.id, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        policy: form.policy,
        modelConfig: form.model,
      })
      notify('项目设置已保存', 'success')
      refresh()
      window.dispatchEvent(new Event('projects:changed'))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      {!owner ? <div className="notice notice--info">只有项目 Owner 可以修改设置。以下内容只读展示。</div> : null}

      <Card title="基本信息">
        <div className="form-stack">
          <div className="form-row">
            <Field label="项目名称">
              <input className="input" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} disabled={!owner} maxLength={80} />
            </Field>
            <Field label="项目标识" hint="用于 /bind 命令和邀请链接，不随名称变化。">
              <input className="input mono" value={project.slug} disabled />
            </Field>
          </div>
          <Field label="项目说明">
            <textarea className="textarea" value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} disabled={!owner} maxLength={2000} />
          </Field>
        </div>
      </Card>

      <Card title="执行策略">
        <div className="form-stack">
          <div className="form-row">
            <Field label="计划审批" hint="需要审批时，计划生成后等待 Maintainer 批准才执行。">
              <select className="select" value={form.policy.planApproval} onChange={(event) => updatePolicy('planApproval', event.target.value as Policy['planApproval'])} disabled={!owner}>
                <option value="auto">自动执行（生成计划后直接执行）</option>
                <option value="required">需要 Maintainer 审批</option>
              </select>
            </Field>
            <Field label="项目并发运行数" hint="同一项目同时执行的 Run 上限（1–4）。">
              <input
                className="input"
                type="number"
                min={1}
                max={4}
                value={form.policy.maxConcurrentRuns}
                onChange={(event) => updatePolicy('maxConcurrentRuns', Math.min(Math.max(Number(event.target.value) || 1, 1), 4))}
                disabled={!owner}
              />
            </Field>
          </div>

          <div className="form-row">
            <Field label="每日 Token 预算" hint="0 表示不限制；超出后拒绝启动新的 Run。">
              <input className="input" type="number" min={0} step={1000} value={form.policy.dailyTokenBudget} onChange={(event) => updatePolicy('dailyTokenBudget', Math.max(Number(event.target.value) || 0, 0))} disabled={!owner} />
            </Field>
            <Field label="单次运行超时（分钟）" hint="Agent 运行超过该时长会被强制终止。">
              <input className="input" type="number" min={1} max={180} value={form.policy.maxRunMinutes} onChange={(event) => updatePolicy('maxRunMinutes', Math.min(Math.max(Number(event.target.value) || 1, 1), 180))} disabled={!owner} />
            </Field>
          </div>

          <div className="form-row">
            <Field label="分支前缀" hint="安全限制：Worker 只会推送 agent/* 分支。">
              <input className="input mono" value={form.policy.branchPrefix} onChange={(event) => updatePolicy('branchPrefix', event.target.value)} disabled={!owner} maxLength={64} />
            </Field>
            <Field label="模型">
              <input className="input" value={form.model.model} onChange={(event) => updateModel('model', event.target.value)} disabled={!owner} />
            </Field>
          </div>

          <div className="form-row">
            <Field label="模型提供方">
              <select className="select" value={form.model.provider} onChange={(event) => updateModel('provider', event.target.value)} disabled={!owner}>
                <option value="deepseek">DeepSeek</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="custom">自定义</option>
              </select>
            </Field>
            <Field label="Temperature">
              <input className="input" type="number" min={0} max={2} step={0.1} value={form.model.temperature} onChange={(event) => updateModel('temperature', Number(event.target.value))} disabled={!owner} />
            </Field>
          </div>

          <label className="checkbox-row">
            <input type="checkbox" checked={form.policy.allowThreadReplies} onChange={(event) => updatePolicy('allowThreadReplies', event.target.checked)} disabled={!owner} />
            <span>
              <strong>工单线程回复免 @bot</strong>
              <span>已建工单的线程内，成员回复会直接追加到工单并触发继续处理。</span>
            </span>
          </label>

          <label className="checkbox-row">
            <input type="checkbox" checked={form.policy.retryOnFailure} onChange={(event) => updatePolicy('retryOnFailure', event.target.checked)} disabled={!owner} />
            <span>
              <strong>失败自动重试一次</strong>
              <span>Agent 运行失败或超时后自动重试一次，仍失败则关闭工单并通知群。</span>
            </span>
          </label>

          <label className="checkbox-row">
            <input type="checkbox" checked={form.policy.membersCanCreateTickets} onChange={(event) => updatePolicy('membersCanCreateTickets', event.target.checked)} disabled={!owner} />
            <span>
              <strong>允许普通成员手动建单</strong>
              <span>关闭后，只有 Maintainer 及以上可以在控制台新建工单；群内 @bot 不受影响。</span>
            </span>
          </label>

          <label className="checkbox-row">
            <input type="checkbox" checked disabled />
            <span>
              <strong>PR 不自动合并（固定策略）</strong>
              <span>平台不会自动合并 PR，必须由人在 GitHub 上完成合并后工单才会关闭。</span>
            </span>
          </label>

          <ErrorNotice message={error} />
          <div className="form-actions">
            <Button variant="primary" onClick={save} loading={busy} disabled={!owner || !form.name.trim()}>
              保存设置
            </Button>
          </div>
        </div>
      </Card>

      <Card title="实现说明">
        <dl className="kv-list">
          <div>
            <dt>执行隔离</dt>
            <dd>每次 Run 使用独立工作目录，Worker 与 API 进程分离；工作目录不跨项目复用。</dd>
          </div>
          <div>
            <dt>仓库保护</dt>
            <dd>只允许推送 agent/* 分支；默认不合并；建议在 GitHub 开启 branch protection。</dd>
          </div>
          <div>
            <dt>密钥</dt>
            <dd>GitHub installation token 按任务下发，任务结束即失效；IM / 模型密钥只存在于部署环境变量。</dd>
          </div>
          <div>
            <dt>数据保留</dt>
            <dd>消息与审计保留期由部署配置决定；归档项目只读，可整体删除。</dd>
          </div>
        </dl>
      </Card>
    </div>
  )
}
