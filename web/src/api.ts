export interface User {
  id: string
  name: string
  avatar: string | null
  email: string | null
  isAdmin: boolean
}

export interface SessionInfo {
  user: User | null
  appName: string
  publicBaseUrl: string
  auth: {
    devLogin: boolean
    oauth: { feishu: boolean; wecom: boolean }
  }
}

export type ProjectStatus = 'draft' | 'active' | 'paused' | 'archived'
export type MemberRole = 'owner' | 'maintainer' | 'member' | 'viewer'
export type TicketStatus = 'new' | 'triaged' | 'planned' | 'running' | 'waiting_review' | 'done' | 'failed' | 'cancelled'
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout'
export type ChannelProvider = 'feishu' | 'wecom'

export interface ProjectSummary {
  id: string
  name: string
  slug: string
  description: string | null
  status: ProjectStatus
  role: MemberRole | null
  repo: { owner: string; name: string; fullName: string; defaultBranch: string; installationId: string } | null
  channel: { id: string; provider: string; name: string | null; externalChatId: string } | null
  openTickets: number
  runningRuns: number
  memberCount: number
  createdAt: string
  updatedAt: string
}

export interface Policy {
  planApproval: 'required' | 'auto'
  allowThreadReplies: boolean
  maxConcurrentRuns: number
  dailyTokenBudget: number
  maxRunMinutes: number
  retryOnFailure: boolean
  requireMergeApproval: boolean
  branchPrefix: string
  membersCanCreateTickets: boolean
}

export interface ModelConfig {
  provider: string
  model: string
  temperature: number
}

export interface ProjectBundle {
  id: string
  name: string
  slug: string
  description: string | null
  ownerId: string
  status: ProjectStatus
  policyJson: Policy
  modelConfig: ModelConfig
  role: MemberRole
  repo: {
    id: string
    installationId: string
    owner: string
    name: string
    fullName: string
    defaultBranch: string
    private: boolean
  } | null
  channel: {
    id: string
    provider: ChannelProvider
    name: string | null
    externalChatId: string
    status: string
    config: Record<string, unknown>
  } | null
  memberCount: number
  readiness: { repo: boolean; channel: boolean; canActivate: boolean }
  createdAt: string
  updatedAt: string
}

export interface Ticket {
  id: string
  projectId: string
  channelId: string | null
  threadKey: string | null
  requesterId: string | null
  requesterName: string | null
  title: string
  body: string
  status: TicketStatus
  priority: 'low' | 'normal' | 'high' | 'urgent'
  plan: string | null
  planApprovedAt: string | null
  prUrl: string | null
  branch: string | null
  lastRunId: string | null
  closedAt: string | null
  stage: string | null
  policyVersion: string | null
  endedReason: string | null
  endedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Run {
  id: string
  projectId: string
  ticketId: string
  kind: 'plan' | 'execute'
  status: RunStatus
  workerId: string | null
  attempt: number
  result: Record<string, unknown> | null
  error: string | null
  tokens: number
  cost: number
  branch: string | null
  prUrl: string | null
  startedAt: string | null
  endedAt: string | null
  createdAt: string
}

export interface RunEvent {
  id: number
  runId: string
  type: string
  message: string | null
  createdAt: string
}

export interface Approval {
  id: string
  kind: 'plan' | 'merge'
  decision: 'approved' | 'rejected'
  actorId: string | null
  comment: string | null
  createdAt: string
}

export interface Message {
  id: string
  provider: string
  text: string
  senderName: string | null
  createdAt: string
  isBot: boolean
}

export interface IntakeEvent {
  id: string
  action: string
  reason: string | null
  command: string | null
  createdAt: string
}

export interface TicketDetail {
  ticket: Ticket
  runs: Run[]
  approvals: Approval[]
  messages: Message[]
  intake: IntakeEvent[]
  ref: string
  stage: string | null
  mandate: {
    id: string
    policyVersion: string
    strength: string
    scope: string
    matchedRules: string[]
    revokedAt: string | null
    createdAt: string
  } | null
  reports: ExecutorReport[]
  inputs: ExecutorInput[]
  session: AgentSession | null
  transcript: { role: string; content: string }[]
  assignments: { id: string; status: string; startedAt: string | null; endedAt: string | null; createdAt: string }[]
  subscriptions: { id: string; threadKey: string; provider: string; kind: string }[]
  turns: Run[]
}

export interface AgentSession {
  id: string
  projectId: string
  role: 'main' | 'executor'
  ticketId: string | null
  status: string
  model: string | null
  preset: string | null
  createdAt: string
  lastTurnAt: string | null
}

export interface ExecutorReport {
  id: string
  status: string
  summary: string
  plan: string | null
  attentionQuestion: string | null
  branch: string | null
  prUrl: string | null
  tokens: number
  cost: number
  createdAt: string
}

export interface ExecutorInput {
  id: string
  source: string
  text: string
  isPerson: boolean
  deliveredAt: string | null
  readAt: string | null
  createdAt: string
}

export interface MainSessionView {
  session: AgentSession | null
  transcript: { role: string; content: string }[]
  turns: Run[]
}

export interface ProjectJoinLink {
  token: string
  url: string
  qrDataUrl: string
  expiresAt: string
}

export interface WecomGroupSetup {
  project: ProjectBundle
  channel: Channel
  group: { chatId: string; name: string; managed: boolean; autoJoin: boolean }
  join: ProjectJoinLink
}

export interface JoinPreview {
  valid: boolean
  reason?: string
  project?: { id: string; name: string; slug: string; status: string }
  group?: { provider: 'wecom'; chatId: string; name: string | null; managed: boolean }
  expiresAt?: string
}

export interface Member {
  id: string
  userId: string
  name: string
  avatar: string | null
  role: MemberRole
  joinedAt: string
  identities: string | null
}

export interface Channel {
  id: string
  provider: ChannelProvider
  externalChatId: string
  name: string | null
  status: 'active' | 'disabled'
  config: Record<string, unknown>
  createdAt: string
}

export interface ProjectGroupInfo {
  provider: ChannelProvider
  name: string | null
  chatId: string
  joinUrl: string | null
  qrDataUrl: string | null
  autoJoin: boolean
}

export interface GroupJoinOutcome {
  group: ProjectGroupInfo | null
  joined: boolean
  error?: string
}

export interface Invite {
  id: string
  role: MemberRole
  expiresAt: string
  maxUses: number
  usedCount: number
  createdAt: string
  revokedAt: string | null
  url: string
  qrDataUrl?: string
}

export interface InvitePreview {
  valid: boolean
  reason?: string
  project: { id: string; name: string; slug: string; status: string } | null
  expiresAt?: string
  maxUses?: number
  usedCount?: number
  role?: MemberRole
  chatProvider?: string
  group?: ProjectGroupInfo | null
}

export interface AuditEntry {
  id: number
  action: string
  target: string | null
  actorId: string | null
  actorLabel: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export interface UsageDay {
  day: string
  runs: number
  tokens: number
  cost: number
}

export interface Overview {
  project: ProjectBundle
  tickets: Record<string, number>
  runs: Record<string, number>
  recentTickets: Ticket[]
  activeRuns: Run[]
  todayTokens: number
  policy: Policy
}

export interface RepoCandidate {
  owner: string
  name: string
  fullName: string
  defaultBranch: string
  private: boolean
}

export class ApiError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

const CSRF_HEADER = { 'x-superagent-csrf': '1' }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (init.method && !['GET', 'HEAD'].includes(init.method)) {
    headers.set('x-superagent-csrf', CSRF_HEADER['x-superagent-csrf'])
  }
  const response = await fetch(path, { credentials: 'include', ...init, headers })
  const text = await response.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error
    throw new ApiError(response.status, error?.code ?? 'internal', error?.message ?? `请求失败（${response.status}）`, error?.details)
  }
  return payload as T
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

export const api = {
  session: () => request<SessionInfo>('/v1/session'),
  devLogin: (name: string) => request<{ user: User }>('/v1/auth/dev-login', { method: 'POST', ...json({ name }) }),
  logout: () => request<{ ok: boolean }>('/v1/auth/logout', { method: 'POST' }),

  projects: {
    list: () => request<{ items: ProjectSummary[] }>('/v1/projects'),
    create: (body: { name: string; description?: string }) => request<{ project: ProjectBundle }>('/v1/projects', { method: 'POST', ...json(body) }),
    get: (projectId: string) => request<{ project: ProjectBundle }>(`/v1/projects/${projectId}`),
    update: (projectId: string, body: Partial<{ name: string; description: string | null; status: ProjectStatus; policy: Policy; modelConfig: ModelConfig }>) =>
      request<{ project: ProjectBundle }>(`/v1/projects/${projectId}`, { method: 'PATCH', ...json(body) }),
    overview: (projectId: string) => request<Overview>(`/v1/projects/${projectId}/overview`),
    audit: (projectId: string, limit = 100) => request<{ items: AuditEntry[] }>(`/v1/projects/${projectId}/audit?limit=${limit}`),
    usage: (projectId: string, days = 30) => request<{ series: UsageDay[]; todayTokens: number; policy: Policy }>(`/v1/projects/${projectId}/usage?days=${days}`),
    mainSession: (projectId: string) => request<MainSessionView>(`/v1/projects/${projectId}/main-session`),
    createWecomGroup: (projectId: string) =>
      request<WecomGroupSetup>(`/v1/projects/${projectId}/wecom-group`, { method: 'POST' }),
    joinLink: (projectId: string) =>
      request<{ channel: Channel | null; join: ProjectJoinLink | null; reason?: string }>(`/v1/projects/${projectId}/join-link`),
  },

  tickets: {
    list: (projectId: string, params: { status?: string; q?: string; limit?: number; offset?: number } = {}) => {
      const query = new URLSearchParams()
      if (params.status) query.set('status', params.status)
      if (params.q) query.set('q', params.q)
      query.set('limit', String(params.limit ?? 30))
      query.set('offset', String(params.offset ?? 0))
      return request<{ items: Ticket[]; total: number; limit: number; offset: number }>(`/v1/projects/${projectId}/tickets?${query.toString()}`)
    },
    create: (projectId: string, body: { title?: string; body: string; priority?: string }) =>
      request<{ ticket: Ticket; warning?: string }>(`/v1/projects/${projectId}/tickets`, { method: 'POST', ...json(body) }),
    detail: (projectId: string, ticketId: string) => request<TicketDetail>(`/v1/projects/${projectId}/tickets/${ticketId}`),
    approve: (projectId: string, ticketId: string, comment?: string) =>
      request<{ run: Run; ticket: Ticket }>(`/v1/projects/${projectId}/tickets/${ticketId}/approve`, { method: 'POST', ...json({ comment }) }),
    cancel: (projectId: string, ticketId: string) =>
      request<{ ticket: Ticket }>(`/v1/projects/${projectId}/tickets/${ticketId}/cancel`, { method: 'POST' }),
    retry: (projectId: string, ticketId: string) =>
      request<{ run: Run; ticket: Ticket }>(`/v1/projects/${projectId}/tickets/${ticketId}/retry`, { method: 'POST' }),
  },

  runs: {
    get: (runId: string) => request<{ run: Run; events: RunEvent[] }>(`/v1/runs/${runId}`),
  },

  members: {
    list: (projectId: string) => request<{ items: Member[] }>(`/v1/projects/${projectId}/members`),
    add: (projectId: string, body: { userId: string; role: string }) =>
      request<{ items: Member[] }>(`/v1/projects/${projectId}/members`, { method: 'POST', ...json(body) }),
    updateRole: (projectId: string, userId: string, role: string) =>
      request<{ items: Member[] }>(`/v1/projects/${projectId}/members/${userId}`, { method: 'PATCH', ...json({ role }) }),
    remove: (projectId: string, userId: string) =>
      request<null>(`/v1/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),
  },

  users: {
    search: (q: string) => request<{ items: { id: string; name: string; email: string | null }[] }>(`/v1/users?q=${encodeURIComponent(q)}`),
  },

  channels: {
    list: (projectId: string) => request<{ items: Channel[] }>(`/v1/projects/${projectId}/channels`),
    bind: (projectId: string, body: { provider: ChannelProvider; externalChatId: string; name?: string; config?: Record<string, unknown> }) =>
      request<{ channel: Channel }>(`/v1/projects/${projectId}/channels`, { method: 'POST', ...json(body) }),
    unbind: (projectId: string, channelId: string) =>
      request<null>(`/v1/projects/${projectId}/channels/${channelId}`, { method: 'DELETE' }),
  },

  repo: {
    get: (projectId: string) =>
      request<{ repo: ProjectBundle['repo']; installations: { installationId: string; accountLogin: string | null; createdAt: string }[]; mode: 'app' | 'mock' }>(
        `/v1/projects/${projectId}/repo`,
      ),
    bind: (projectId: string, body: { installationId: string; owner: string; name: string; defaultBranch?: string }) =>
      request<{ repo: ProjectBundle['repo'] }>(`/v1/projects/${projectId}/repo`, { method: 'POST', ...json(body) }),
    unbind: (projectId: string) => request<null>(`/v1/projects/${projectId}/repo`, { method: 'DELETE' }),
    candidates: (projectId: string, installationId?: string) =>
      request<{ items: RepoCandidate[]; mode: 'app' | 'mock' }>(
        `/v1/projects/${projectId}/repo/candidates${installationId ? `?installationId=${encodeURIComponent(installationId)}` : ''}`,
      ),
    installUrl: (projectId: string) => `/v1/github/install/start?projectId=${encodeURIComponent(projectId)}`,
  },

  wecomJoin: {
    preview: (token: string) => request<JoinPreview>(`/v1/join/${encodeURIComponent(token)}`),
    accept: (token: string) =>
      request<{ projectId: string; role: MemberRole; alreadyMember: boolean; group: GroupJoinOutcome }>(
        `/v1/join/${encodeURIComponent(token)}/accept`,
        { method: 'POST' },
      ),
  },

  invites: {
    list: (projectId: string) => request<{ items: Invite[] }>(`/v1/projects/${projectId}/invites`),
    create: (projectId: string, body: { role?: string; maxUses?: number; expiresInHours?: number }) =>
      request<{ invite: Invite; token: string }>(`/v1/projects/${projectId}/invites`, { method: 'POST', ...json(body) }),
    revoke: (projectId: string, inviteId: string) =>
      request<null>(`/v1/projects/${projectId}/invites/${inviteId}`, { method: 'DELETE' }),
    preview: (token: string) => request<{ invite: InvitePreview }>(`/v1/invites/${encodeURIComponent(token)}`),
    accept: (token: string) =>
      request<{ project: ProjectBundle; role: MemberRole; alreadyMember: boolean; group: GroupJoinOutcome }>(
        `/v1/invites/${encodeURIComponent(token)}/accept`,
        { method: 'POST' },
      ),
  },
}
