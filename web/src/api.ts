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

export interface Bot {
  id: string
  projectId: string
  slug: string
  name: string
  roleTitle: string
  avatar: string | null
  status: 'active' | 'paused' | 'archived'
  systemPrompt: string
  modelConfig: {
    baseUrl?: string
    apiKeyRef?: string
    model?: string
    temperature?: number
    maxOutputTokens?: number
    maxSteps?: number
  }
  toolPolicy: {
    allowedTools?: string[]
    mcpServerIds?: string[]
    rules?: Record<string, 'allow' | 'confirm' | 'deny'>
  }
  sandboxConfig: {
    mode?: 'local' | 'docker'
    image?: string
    memoryMb?: number
    cpus?: number
    browserEnabled?: boolean
    networkMode?: 'none' | 'bridge'
  }
  imBinding: {
    provider?: 'feishu' | 'wecom'
    botId?: string
    appId?: string
    secretRef?: string
  } | null
  sandboxState: 'stopped' | 'starting' | 'running' | 'error'
  containerId: string | null
  lastActiveAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Room {
  id: string
  projectId: string
  kind: 'group' | 'dm' | 'routine_feed'
  name: string
  topic: string | null
  channelId: string | null
  dmUserId: string | null
  defaultBotId: string | null
  maxHandoffHops: number
  status: 'active' | 'archived'
  bots: Array<Pick<Bot, 'id' | 'slug' | 'name' | 'roleTitle' | 'avatar' | 'status' | 'sandboxState'>>
  lastMessage: { content: string; authorName: string; createdAt: string; kind: string } | null
  createdAt: string
  updatedAt: string
}

export interface RoomAttachment {
  type: 'screenshot' | 'file' | 'pr' | 'diff' | 'link' | 'approval'
  title: string
  url?: string
  mimeType?: string
  metadata?: Record<string, unknown>
}

export interface RoomMessage {
  id: string
  projectId: string
  roomId: string
  threadKey: string
  authorKind: 'user' | 'bot' | 'system'
  authorUserId: string | null
  authorBotId: string | null
  kind: 'chat' | 'handoff' | 'status' | 'approval_card' | 'artifact' | 'report'
  content: string
  attachments: RoomAttachment[]
  ticketId: string | null
  turnId: string | null
  authorName: string
  authorAvatar: string | null
  botSlug: string | null
  botRoleTitle: string | null
  ticketShortName: string | null
  ticketStage: string | null
  createdAt: string
}

export interface ProjectStreamEvent {
  type: 'room.message' | 'bot.status' | 'turn.event' | 'ticket.updated' | 'approval.created' | 'approval.resolved' | 'routine.run'
  projectId: string
  timestamp: string
  data: Record<string, unknown>
}

export function subscribeProjectEvents(
  projectId: string,
  onEvent: (event: ProjectStreamEvent) => void,
): () => void {
  const source = new EventSource(`/v1/projects/${encodeURIComponent(projectId)}/events/stream`, { withCredentials: true })
  const types: ProjectStreamEvent['type'][] = [
    'room.message',
    'bot.status',
    'turn.event',
    'ticket.updated',
    'approval.created',
    'approval.resolved',
    'routine.run',
  ]
  const handler = (raw: MessageEvent) => {
    try {
      const parsed = JSON.parse(String(raw.data)) as ProjectStreamEvent
      onEvent(parsed)
    } catch {
      // ignore malformed frames
    }
  }
  for (const type of types) {
    source.addEventListener(type, handler as EventListener)
  }
  return () => {
    source.close()
  }
}

export interface ActionApproval {
  id: string
  projectId: string
  roomId: string | null
  ticketId: string
  turnId: string
  botId: string | null
  toolName: string
  toolCallId: string
  riskLevel: 'medium' | 'high'
  title: string
  preview: Record<string, unknown>
  toolArgs: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected' | 'revision_requested' | 'expired'
  decidedBy: string | null
  decisionComment: string | null
  decidedAt: string | null
  expiresAt: string | null
  botName: string | null
  botSlug: string | null
  botAvatar: string | null
  ticketTitle: string | null
  ticketShortName: string | null
  roomName: string | null
  decidedByName: string | null
  createdAt: string
}

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpServer {
  id: string
  projectId: string
  name: string
  transport: 'stdio' | 'streamable_http' | 'sse'
  endpointOrCmd: string
  args: string[]
  envRefs: Record<string, string>
  enabled: boolean
  defaultToolPolicy: 'allow' | 'confirm' | 'confirm_all' | 'deny'
  cachedTools: McpToolDescriptor[]
  lastHealthAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ArtifactItem {
  id: string
  projectId: string
  ticketId: string | null
  turnId: string | null
  botId: string | null
  kind: string
  title: string
  mimeType: string
  sizeBytes: number
  createdAt: string
}

export interface Routine {
  id: string
  projectId: string
  botId: string | null
  roomId: string | null
  name: string
  description: string | null
  enabled: boolean
  triggerType: 'cron' | 'webhook' | 'repo_event'
  cronExpr: string | null
  timezone: string
  eventFilter: { events?: string[]; branches?: string[] }
  prompt: string
  notifyOnQuiet: boolean
  maxBudgetUsd: number
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  lastTicketId: string | null
  botName: string | null
  botSlug: string | null
  botAvatar: string | null
  roomName: string | null
  createdAt: string
  updatedAt: string
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
    bindLocal: (projectId: string, body: { path: string; defaultBranch?: string }) =>
      request<{ repo: ProjectBundle['repo'] }>(`/v1/projects/${projectId}/local-repo`, { method: 'POST', ...json(body) }),
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

  bots: {
    list: (projectId: string) => request<{ items: Bot[] }>(`/v1/projects/${projectId}/bots`),
    create: (projectId: string, body: Partial<Bot> & { name: string; roleTitle: string }) =>
      request<{ bot: Bot }>(`/v1/projects/${projectId}/bots`, { method: 'POST', ...json(body) }),
    installRdTemplates: (projectId: string) =>
      request<{ created: Bot[]; items: Bot[] }>(`/v1/projects/${projectId}/bots/templates/rd`, { method: 'POST', ...json({}) }),
    update: (projectId: string, botId: string, body: Partial<Bot>) =>
      request<{ bot: Bot }>(`/v1/projects/${projectId}/bots/${botId}`, { method: 'PATCH', ...json(body) }),
    archive: (projectId: string, botId: string) =>
      request<{ bot: Bot }>(`/v1/projects/${projectId}/bots/${botId}`, { method: 'DELETE' }),
  },

  rooms: {
    list: (projectId: string) => request<{ items: Room[] }>(`/v1/projects/${projectId}/rooms`),
    create: (projectId: string, body: { kind?: Room['kind']; name?: string; topic?: string; botIds?: string[]; defaultBotId?: string; maxHandoffHops?: number }) =>
      request<{ room: Room }>(`/v1/projects/${projectId}/rooms`, { method: 'POST', ...json(body) }),
    update: (projectId: string, roomId: string, body: { name?: string; topic?: string; maxHandoffHops?: number; botIds?: string[]; status?: 'active' | 'archived' }) =>
      request<{ room: Room }>(`/v1/projects/${projectId}/rooms/${roomId}`, { method: 'PATCH', ...json(body) }),
    messages: (projectId: string, roomId: string, limit = 100) =>
      request<{ items: RoomMessage[] }>(`/v1/projects/${projectId}/rooms/${roomId}/messages?limit=${limit}`),
    postMessage: (projectId: string, roomId: string, body: { content: string; threadKey?: string; targetBotSlug?: string }) =>
      request<{ message: RoomMessage; triggerId?: string; commandReply?: string }>(`/v1/projects/${projectId}/rooms/${roomId}/messages`, {
        method: 'POST',
        ...json(body),
      }),
  },

  approvals: {
    list: (projectId: string, status?: ActionApproval['status']) =>
      request<{ items: ActionApproval[] }>(
        `/v1/projects/${projectId}/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`,
      ),
    decide: (
      projectId: string,
      approvalId: string,
      body: { decision: 'approved' | 'rejected' | 'revision_requested'; comment?: string },
    ) =>
      request<{ approval: ActionApproval; resumeTurnId: string }>(
        `/v1/projects/${projectId}/approvals/${approvalId}/decide`,
        { method: 'POST', ...json(body) },
      ),
  },

  mcp: {
    list: (projectId: string) => request<{ items: McpServer[] }>(`/v1/projects/${projectId}/mcp-servers`),
    create: (
      projectId: string,
      body: {
        name: string
        transport?: McpServer['transport']
        endpointOrCmd: string
        args?: string[]
        envRefs?: Record<string, string>
        enabled?: boolean
        defaultToolPolicy?: McpServer['defaultToolPolicy']
      },
    ) => request<{ server: McpServer }>(`/v1/projects/${projectId}/mcp-servers`, { method: 'POST', ...json(body) }),
    update: (
      projectId: string,
      serverId: string,
      body: Partial<Pick<McpServer, 'name' | 'transport' | 'endpointOrCmd' | 'args' | 'envRefs' | 'enabled' | 'defaultToolPolicy'>>,
    ) => request<{ server: McpServer }>(`/v1/projects/${projectId}/mcp-servers/${serverId}`, { method: 'PATCH', ...json(body) }),
    remove: (projectId: string, serverId: string) =>
      request<null>(`/v1/projects/${projectId}/mcp-servers/${serverId}`, { method: 'DELETE' }),
    discover: (projectId: string, serverId: string) =>
      request<{ server: McpServer; tools: McpToolDescriptor[] }>(`/v1/projects/${projectId}/mcp-servers/${serverId}/discover`, {
        method: 'POST',
        ...json({}),
      }),
  },

  artifacts: {
    list: (projectId: string, limit = 30) =>
      request<{ items: ArtifactItem[] }>(`/v1/projects/${projectId}/artifacts?limit=${limit}`),
    url: (projectId: string, artifactId: string) =>
      `/v1/projects/${projectId}/artifacts/${artifactId}`,
  },

  routines: {
    list: (projectId: string) => request<{ items: Routine[] }>(`/v1/projects/${projectId}/routines`),
    create: (
      projectId: string,
      body: {
        name: string
        description?: string | null
        botId?: string | null
        roomId?: string | null
        enabled?: boolean
        triggerType?: Routine['triggerType']
        cronExpr?: string | null
        timezone?: string
        eventFilter?: Routine['eventFilter']
        prompt: string
        notifyOnQuiet?: boolean
        maxBudgetUsd?: number
      },
    ) => request<{ routine: Routine }>(`/v1/projects/${projectId}/routines`, { method: 'POST', ...json(body) }),
    update: (projectId: string, routineId: string, body: Partial<Routine>) =>
      request<{ routine: Routine }>(`/v1/projects/${projectId}/routines/${routineId}`, { method: 'PATCH', ...json(body) }),
    remove: (projectId: string, routineId: string) =>
      request<null>(`/v1/projects/${projectId}/routines/${routineId}`, { method: 'DELETE' }),
    runNow: (projectId: string, routineId: string) =>
      request<{ triggerId: string; routine: Routine }>(`/v1/projects/${projectId}/routines/${routineId}/run`, {
        method: 'POST',
        ...json({}),
      }),
  },
}
