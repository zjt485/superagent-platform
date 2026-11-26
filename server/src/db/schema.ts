import { sql } from 'drizzle-orm'
import {
  bigserial,
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { ModelConfig, ProjectPolicy } from '../domain/policy.js'
import type { OutboxMessage } from '../domain/outbox.js'

export const projectStatusEnum = pgEnum('project_status', ['draft', 'active', 'paused', 'archived'])
export const memberRoleEnum = pgEnum('member_role', ['owner', 'maintainer', 'member', 'viewer'])
export const channelProviderEnum = pgEnum('channel_provider', ['feishu', 'wecom'])
export const channelStatusEnum = pgEnum('channel_status', ['active', 'disabled'])
export const ticketStatusEnum = pgEnum('ticket_status', [
  'new',
  'triaged',
  'planned',
  'running',
  'waiting_review',
  'done',
  'failed',
  'cancelled',
])
export const ticketPriorityEnum = pgEnum('ticket_priority', ['low', 'normal', 'high', 'urgent'])
export const runStatusEnum = pgEnum('run_status', ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'])
export const runKindEnum = pgEnum('run_kind', ['plan', 'execute'])
export const approvalKindEnum = pgEnum('approval_kind', ['plan', 'merge'])
export const approvalDecisionEnum = pgEnum('approval_decision', ['approved', 'rejected'])
export const intakeActionEnum = pgEnum('intake_action', [
  'ticket_created',
  'ticket_appended',
  'command',
  'ignored',
  'duplicate',
])
export const outboxStatusEnum = pgEnum('outbox_status', ['pending', 'sent', 'failed'])

export const sessionRoleEnum = pgEnum('session_role', ['main', 'executor'])
export const sessionStatusEnum = pgEnum('session_status', ['idle', 'queued', 'running', 'error'])
export const turnKindEnum = pgEnum('turn_kind', ['eval', 'execute', 'resume'])
export const turnStatusEnum = pgEnum('turn_status', ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'])
export const evaluationStatusEnum = pgEnum('evaluation_status', ['queued', 'running', 'decided', 'unavailable'])
export const mandateStrengthEnum = pgEnum('mandate_strength', ['explicit', 'inferred'])
export const assignmentStatusEnum = pgEnum('assignment_status', ['pending', 'running', 'ended'])
export const reportStatusEnum = pgEnum('report_status', ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'])
export const subscriptionKindEnum = pgEnum('subscription_kind', ['own', 'context'])
export const inputSourceEnum = pgEnum('input_source', ['trigger', 'person', 'note', 'policy', 'approval', 'system'])
export const triggerKindEnum = pgEnum('trigger_kind', ['message', 'command', 'ci', 'pr_comment', 'pr_merge', 'pr_close', 'resume', 'handoff', 'routine'])
export const botStatusEnum = pgEnum('bot_status', ['active', 'paused', 'archived'])
export const botSandboxStateEnum = pgEnum('bot_sandbox_state', ['stopped', 'starting', 'running', 'error'])
export const roomKindEnum = pgEnum('room_kind', ['group', 'dm', 'routine_feed'])
export const roomStatusEnum = pgEnum('room_status', ['active', 'archived'])
export const roomAuthorKindEnum = pgEnum('room_author_kind', ['user', 'bot', 'system'])
export const roomMessageKindEnum = pgEnum('room_message_kind', ['chat', 'handoff', 'status', 'approval_card', 'artifact', 'report'])

export interface BotModelConfig {
  baseUrl?: string
  apiKeyRef?: string
  model?: string
  temperature?: number
  maxOutputTokens?: number
  maxSteps?: number
}

export type ToolRiskDecision = 'allow' | 'confirm' | 'deny'

export interface BotToolPolicy {
  allowedTools?: string[]
  mcpServerIds?: string[]
  rules?: Record<string, ToolRiskDecision>
}

export interface BotSandboxConfig {
  mode?: 'local' | 'docker'
  image?: string
  memoryMb?: number
  cpus?: number
  browserEnabled?: boolean
  networkMode?: 'none' | 'bridge'
}

export interface BotImBinding {
  provider?: 'feishu' | 'wecom'
  botId?: string
  appId?: string
  secretRef?: string
}

export interface RoomAttachment {
  type: 'screenshot' | 'file' | 'pr' | 'diff' | 'link' | 'approval'
  title: string
  url?: string
  mimeType?: string
  metadata?: Record<string, unknown>
}
export const triggerDispositionEnum = pgEnum('trigger_disposition', [
  'pending',
  'attached',
  'new_ticket',
  'ignored',
  'stopped',
  'command',
  'pending_review',
])
export const triggerAddressEnum = pgEnum('trigger_address', ['mention', 'direct', 'ambient'])
export const decisionActionEnum = pgEnum('decision_action', ['new', 'attach', 'ignore', 'stop', 'command'])
export const inputKindEnum = pgEnum('input_kind', ['message', 'approval', 'policy', 'note', 'system'])

const createdAt = timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
const updatedAt = timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    avatar: text('avatar'),
    email: text('email'),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt,
    updatedAt,
  },
  (table) => [index('users_email_idx').on(table.email)],
)

export const identities = pgTable(
  'identities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    displayName: text('display_name'),
    createdAt,
  },
  (table) => [uniqueIndex('identities_provider_external_uq').on(table.provider, table.externalId), index('identities_user_idx').on(table.userId)],
)

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt,
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [uniqueIndex('auth_sessions_token_uq').on(table.tokenHash), index('auth_sessions_user_idx').on(table.userId)],
)

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: projectStatusEnum('status').notNull().default('draft'),
    policyJson: jsonb('policy_json').$type<ProjectPolicy>().notNull(),
    modelConfig: jsonb('model_config').$type<ModelConfig>().notNull(),
    description: text('description'),
    createdAt,
    updatedAt,
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [uniqueIndex('projects_slug_uq').on(table.slug), index('projects_owner_idx').on(table.ownerId), index('projects_status_idx').on(table.status)],
)

export const projectMembers = pgTable(
  'project_members',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum('role').notNull().default('member'),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    joinedAt: createdAt,
  },
  (table) => [
    uniqueIndex('project_members_uq').on(table.projectId, table.userId),
    index('project_members_user_idx').on(table.userId),
  ],
)

export const repos = pgTable(
  'repos',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('github'),
    installationId: text('installation_id').notNull(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    private: boolean('private').notNull().default(true),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex('repos_project_uq').on(table.projectId), index('repos_full_name_idx').on(table.fullName)],
)

export const projectInstallations = pgTable(
  'project_installations',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    installationId: text('installation_id').notNull(),
    accountLogin: text('account_login'),
    accountType: text('account_type'),
    createdAt,
  },
  (table) => [uniqueIndex('project_installations_uq').on(table.projectId, table.installationId)],
)

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provider: channelProviderEnum('provider').notNull(),
    externalChatId: text('external_chat_id').notNull(),
    name: text('name'),
    status: channelStatusEnum('status').notNull().default('active'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('channels_provider_chat_uq').on(table.provider, table.externalChatId),
    uniqueIndex('channels_active_project_uq')
      .on(table.projectId)
      .where(sql`status = 'active'`),
  ],
)

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    role: memberRoleEnum('role').notNull().default('member'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    maxUses: integer('max_uses').notNull().default(50),
    usedCount: integer('used_count').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [uniqueIndex('invites_token_uq').on(table.tokenHash), index('invites_project_idx').on(table.projectId)],
)

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
    threadKey: text('thread_key'),
    requesterId: uuid('requester_id').references(() => users.id, { onDelete: 'set null' }),
    requesterName: text('requester_name'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    status: ticketStatusEnum('status').notNull().default('new'),
    priority: ticketPriorityEnum('priority').notNull().default('normal'),
    plan: text('plan'),
    planApprovedAt: timestamp('plan_approved_at', { withTimezone: true, mode: 'date' }),
    prUrl: text('pr_url'),
    branch: text('branch'),
    shortName: text('short_name'),
    worktreePath: text('worktree_path'),
    baseRef: text('base_ref'),
    lastRunId: uuid('last_run_id'),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),

    // Dual-agent core: stage is the source of truth, status remains a
    // compatibility projection for the existing console.
    stage: text('stage'),
    policyVersion: text('policy_version'),
    originTriggerId: uuid('origin_trigger_id'),
    lastReportId: uuid('last_report_id'),
    endedReason: text('ended_reason'),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),

    // Multi-bot rooms & handoffs.
    botId: uuid('bot_id'),
    roomId: uuid('room_id'),
    handoffChainId: uuid('handoff_chain_id'),
    handoffHop: integer('handoff_hop').notNull().default(0),
    parentTicketId: uuid('parent_ticket_id'),

    createdAt,
    updatedAt,
  },
  (table) => [
    index('tickets_project_status_idx').on(table.projectId, table.status),
    index('tickets_thread_idx').on(table.projectId, table.channelId, table.threadKey),
    index('tickets_created_idx').on(table.createdAt),
    uniqueIndex('tickets_short_name_uq')
      .on(table.projectId, table.shortName)
      .where(sql`short_name is not null`),
  ],
)

export const threads = pgTable(
  'threads',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
    threadKey: text('thread_key').notNull(),
    summary: text('summary'),
    routerPending: boolean('router_pending').notNull().default(false),
    routerLeaseUntil: timestamp('router_lease_until', { withTimezone: true, mode: 'date' }),
    lastTriggerAt: timestamp('last_trigger_at', { withTimezone: true, mode: 'date' }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('threads_key_uq').on(table.projectId, table.channelId, table.threadKey),
    index('threads_pending_idx').on(table.routerPending, table.routerLeaseUntil),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    providerMessageId: text('provider_message_id').notNull(),
    senderId: uuid('sender_id').references(() => users.id, { onDelete: 'set null' }),
    externalSenderId: text('external_sender_id'),
    senderName: text('sender_name'),
    text: text('text').notNull(),
    threadKey: text('thread_key'),
    replyToMessageId: text('reply_to_message_id'),
    isBot: boolean('is_bot').notNull().default(false),
    raw: jsonb('raw').$type<unknown>(),
    createdAt,
  },
  (table) => [
    uniqueIndex('messages_provider_message_uq').on(table.provider, table.providerMessageId),
    index('messages_thread_idx').on(table.projectId, table.channelId, table.threadKey),
  ],
)

export const intakeEvents = pgTable(
  'intake_events',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    action: intakeActionEnum('action').notNull(),
    reason: text('reason'),
    command: text('command'),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    createdAt,
  },
  (table) => [uniqueIndex('intake_events_message_uq').on(table.messageId), index('intake_events_project_idx').on(table.projectId, table.createdAt)],
)

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    kind: approvalKindEnum('kind').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    decision: approvalDecisionEnum('decision').notNull(),
    comment: text('comment'),
    createdAt,
  },
  (table) => [index('approvals_ticket_idx').on(table.ticketId)],
)

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    target: text('target'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt,
  },
  (table) => [index('audit_logs_project_idx').on(table.projectId, table.createdAt), index('audit_logs_action_idx').on(table.action)],
)

export const usage = pgTable(
  'usage',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    runs: integer('runs').notNull().default(0),
    tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
    cost: numeric('cost', { precision: 14, scale: 6, mode: 'number' }).notNull().default(0),
  },
  (table) => [uniqueIndex('usage_project_day_uq').on(table.projectId, table.day)],
)

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    dedupeKey: text('dedupe_key'),
    payload: jsonb('payload').$type<OutboxMessage>().notNull(),
    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt,
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('outbox_dedupe_uq').on(table.dedupeKey),
    index('outbox_pending_idx').on(table.status, table.nextAttemptAt),
  ],
)

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    deliveryId: text('delivery_id').notNull(),
    eventType: text('event_type'),
    receivedAt: createdAt,
  },
  (table) => [uniqueIndex('webhook_deliveries_uq').on(table.provider, table.deliveryId)],
)

// ---------------------------------------------------------------------------
// Dual-agent core
// ---------------------------------------------------------------------------

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    role: sessionRoleEnum('role').notNull(),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    status: sessionStatusEnum('status').notNull().default('idle'),
    model: text('model'),
    preset: text('preset'),
    externalId: text('external_id'),
    createdAt,
    updatedAt,
    lastTurnAt: timestamp('last_turn_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('agent_sessions_main_uq')
      .on(table.projectId)
      .where(sql`role = 'main'`),
    uniqueIndex('agent_sessions_executor_uq')
      .on(table.ticketId)
      .where(sql`role = 'executor'`),
    index('agent_sessions_project_role_idx').on(table.projectId, table.role),
  ],
)

export const triggers = pgTable(
  'triggers',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    kind: triggerKindEnum('kind').notNull().default('message'),
    threadKey: text('thread_key'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorExternalId: text('actor_external_id'),
    actorName: text('actor_name'),
    text: text('text').notNull(),
    isBot: boolean('is_bot').notNull().default(false),
    mentionedBot: boolean('mentioned_bot').notNull().default(false),
    replyTo: text('reply_to'),
    raw: jsonb('raw').$type<unknown>(),
    evaluationId: uuid('evaluation_id'),
    disposition: triggerDispositionEnum('disposition').notNull().default('pending'),
    address: triggerAddressEnum('address').notNull().default('mention'),
    roomId: uuid('room_id'),
    targetBotId: uuid('target_bot_id'),
    sourceBotId: uuid('source_bot_id'),
    handoffChainId: uuid('handoff_chain_id'),
    handoffHop: integer('handoff_hop').notNull().default(0),
    createdAt,
  },
  (table) => [
    uniqueIndex('triggers_provider_external_uq').on(table.provider, table.externalId),
    index('triggers_thread_idx').on(table.projectId, table.channelId, table.threadKey),
    index('triggers_project_created_idx').on(table.projectId, table.createdAt),
    index('triggers_pending_idx').on(table.projectId, table.disposition, table.createdAt),
  ],
)

export const evaluations = pgTable(
  'evaluations',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
    threadKey: text('thread_key').notNull(),
    policyVersion: text('policy_version').notNull(),
    status: evaluationStatusEnum('status').notNull().default('queued'),
    triggerIds: jsonb('trigger_ids').$type<string[]>().notNull().default([]),
    decision: jsonb('decision').$type<unknown>(),
    reason: text('reason'),
    attempts: integer('attempts').notNull().default(0),
    model: text('model'),
    promptTokens: integer('prompt_tokens'),
    outputTokens: integer('output_tokens'),
    summary: text('summary'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    createdAt,
  },
  (table) => [
    uniqueIndex('evaluations_active_uq')
      .on(table.projectId, table.channelId, table.threadKey)
      .where(sql`status in ('queued', 'running')`),
    index('evaluations_project_status_idx').on(table.projectId, table.status),
  ],
)

export const decisions = pgTable(
  'decisions',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => evaluations.id, { onDelete: 'cascade' }),
    triggerId: uuid('trigger_id')
      .notNull()
      .references(() => triggers.id, { onDelete: 'cascade' }),
    threadKey: text('thread_key'),
    action: decisionActionEnum('action').notNull(),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    title: text('title'),
    reason: text('reason').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 2, mode: 'number' }),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex('decisions_trigger_uq').on(table.triggerId),
    index('decisions_run_idx').on(table.runId),
    index('decisions_project_time_idx').on(table.projectId, table.decidedAt),
  ],
)

export const mandates = pgTable(
  'mandates',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    policyVersion: text('policy_version').notNull(),
    strength: mandateStrengthEnum('strength').notNull(),
    scope: text('scope').notNull(),
    matchedRules: jsonb('matched_rules').$type<string[]>().notNull().default([]),
    basis: jsonb('basis').$type<Record<string, unknown>>().notNull().default({}),
    requesterTriggerId: uuid('requester_trigger_id').references(() => triggers.id, { onDelete: 'set null' }),
    requesterUserId: uuid('requester_user_id').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt,
  },
  (table) => [uniqueIndex('mandates_ticket_uq').on(table.ticketId)],
)

export const sessionTurns = pgTable(
  'session_turns',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    botId: uuid('bot_id'),
    evaluationId: uuid('evaluation_id').references(() => evaluations.id, { onDelete: 'set null' }),
    assignmentId: uuid('assignment_id'),
    kind: turnKindEnum('kind').notNull(),
    status: turnStatusEnum('status').notNull().default('queued'),
    model: text('model'),
    seq: integer('seq'),
    pid: integer('pid'),
    exitCode: integer('exit_code'),
    input: jsonb('input').$type<unknown>(),
    prompt: text('prompt'),
    result: jsonb('result').$type<unknown>(),
    error: text('error'),
    tokens: integer('tokens').notNull().default(0),
    cost: numeric('cost', { precision: 12, scale: 6, mode: 'number' }).notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'date' }),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true, mode: 'date' }),
    createdAt,
  },
  (table) => [
    // Queued turns may stack; only one may run per session.
    uniqueIndex('session_turns_running_uq')
      .on(table.sessionId)
      .where(sql`status = 'running'`),
    index('session_turns_queue_idx').on(table.status, table.createdAt),
    index('session_turns_ticket_idx').on(table.ticketId, table.createdAt),
    uniqueIndex('session_turns_ticket_seq_uq')
      .on(table.ticketId, table.seq)
      .where(sql`ticket_id is not null and seq is not null`),
  ],
)

export const sessionMessages = pgTable(
  'session_messages',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    turnId: uuid('turn_id').references(() => sessionTurns.id, { onDelete: 'set null' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt,
  },
  (table) => [index('session_messages_session_idx').on(table.sessionId, table.createdAt)],
)

export const ticketSubscriptions = pgTable(
  'ticket_subscriptions',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
    threadKey: text('thread_key').notNull(),
    kind: subscriptionKindEnum('kind').notNull().default('own'),
    createdAt,
  },
  (table) => [
    uniqueIndex('ticket_subscriptions_uq').on(table.ticketId, table.provider, table.threadKey),
    index('ticket_subscriptions_thread_idx').on(table.projectId, table.provider, table.threadKey),
  ],
)

export const ticketInputs = pgTable(
  'ticket_inputs',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    triggerId: uuid('trigger_id').references(() => triggers.id, { onDelete: 'set null' }),
    source: inputSourceEnum('source').notNull(),
    kind: inputKindEnum('kind').notNull().default('message'),
    text: text('text').notNull(),
    isPerson: boolean('is_person').notNull().default(false),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    deliveredTurnId: uuid('delivered_turn_id').references(() => sessionTurns.id, { onDelete: 'set null' }),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    createdAt,
  },
  (table) => [
    index('ticket_inputs_ticket_idx').on(table.ticketId, table.createdAt),
    index('ticket_inputs_turn_idx').on(table.deliveredTurnId),
  ],
)

export const assignments = pgTable(
  'assignments',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    status: assignmentStatusEnum('status').notNull().default('pending'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    createdAt,
  },
  (table) => [
    uniqueIndex('assignments_active_uq')
      .on(table.ticketId)
      .where(sql`status in ('pending', 'running')`),
    index('assignments_ticket_idx').on(table.ticketId, table.createdAt),
  ],
)

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    assignmentId: uuid('assignment_id').references(() => assignments.id, { onDelete: 'set null' }),
    turnId: uuid('turn_id').references(() => sessionTurns.id, { onDelete: 'set null' }),
    status: reportStatusEnum('status').notNull(),
    summary: text('summary').notNull().default(''),
    plan: text('plan'),
    attentionQuestion: text('attention_question'),
    attentionAnsweredAt: timestamp('attention_answered_at', { withTimezone: true, mode: 'date' }),
    branch: text('branch'),
    prUrl: text('pr_url'),
    tokens: integer('tokens').notNull().default(0),
    cost: numeric('cost', { precision: 12, scale: 6, mode: 'number' }).notNull().default(0),
    raw: jsonb('raw').$type<unknown>(),
    createdAt,
  },
  (table) => [index('reports_ticket_idx').on(table.ticketId, table.createdAt)],
)

export const turnEvents = pgTable(
  'turn_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => sessionTurns.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    message: text('message'),
    payload: jsonb('payload').$type<unknown>(),
    createdAt,
  },
  (table) => [index('turn_events_turn_idx').on(table.turnId, table.id)],
)

export const bots = pgTable(
  'bots',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    roleTitle: text('role_title').notNull(),
    avatar: text('avatar'),
    status: botStatusEnum('status').notNull().default('active'),
    systemPrompt: text('system_prompt').notNull().default(''),
    modelConfig: jsonb('model_config').$type<BotModelConfig>().notNull().default({}),
    toolPolicy: jsonb('tool_policy').$type<BotToolPolicy>().notNull().default({}),
    sandboxConfig: jsonb('sandbox_config').$type<BotSandboxConfig>().notNull().default({}),
    imBinding: jsonb('im_binding').$type<BotImBinding | null>(),
    sandboxState: botSandboxStateEnum('sandbox_state').notNull().default('stopped'),
    containerId: text('container_id'),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true, mode: 'date' }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('bots_project_slug_uq').on(table.projectId, table.slug),
    index('bots_project_status_idx').on(table.projectId, table.status),
  ],
)

export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: roomKindEnum('kind').notNull().default('group'),
    name: text('name').notNull(),
    topic: text('topic'),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
    dmUserId: uuid('dm_user_id').references(() => users.id, { onDelete: 'cascade' }),
    defaultBotId: uuid('default_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    maxHandoffHops: integer('max_handoff_hops').notNull().default(5),
    status: roomStatusEnum('status').notNull().default('active'),
    createdAt,
    updatedAt,
  },
  (table) => [
    index('rooms_project_idx').on(table.projectId, table.kind),
    index('rooms_channel_idx').on(table.channelId),
  ],
)

export const roomBots = pgTable(
  'room_bots',
  {
    id: uuid('id').primaryKey(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('room_bots_uq').on(table.roomId, table.botId)],
)

export const roomMessages = pgTable(
  'room_messages',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    threadKey: text('thread_key').notNull(),
    authorKind: roomAuthorKindEnum('author_kind').notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorBotId: uuid('author_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    kind: roomMessageKindEnum('kind').notNull().default('chat'),
    content: text('content').notNull(),
    attachments: jsonb('attachments').$type<RoomAttachment[]>().notNull().default([]),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    turnId: uuid('turn_id').references(() => sessionTurns.id, { onDelete: 'set null' }),
    replyToId: uuid('reply_to_id'),
    externalProvider: text('external_provider'),
    externalMessageId: text('external_message_id'),
    createdAt,
  },
  (table) => [
    index('room_messages_room_time_idx').on(table.roomId, table.createdAt),
    uniqueIndex('room_messages_external_uq')
      .on(table.externalProvider, table.externalMessageId)
      .where(sql`external_provider is not null and external_message_id is not null`),
  ],
)

export const schema = {
  users,
  identities,
  authSessions,
  projects,
  projectMembers,
  repos,
  projectInstallations,
  channels,
  invites,
  tickets,
  messages,
  intakeEvents,
  approvals,
  auditLogs,
  usage,
  outboxEvents,
  webhookDeliveries,
  agentSessions,
  threads,
  triggers,
  evaluations,
  decisions,
  mandates,
  sessionTurns,
  sessionMessages,
  ticketSubscriptions,
  ticketInputs,
  assignments,
  reports,
  turnEvents,
  bots,
  rooms,
  roomBots,
  roomMessages,
}

export type Schema = typeof schema
export type UserRow = typeof users.$inferSelect
export type ProjectRow = typeof projects.$inferSelect
export type TicketRow = typeof tickets.$inferSelect

export type ChannelRow = typeof channels.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type RepoRow = typeof repos.$inferSelect
export type InviteRow = typeof invites.$inferSelect
export type MemberRow = typeof projectMembers.$inferSelect
export type OutboxRow = typeof outboxEvents.$inferSelect
export type TriggerRow = typeof triggers.$inferSelect
export type ThreadRow = typeof threads.$inferSelect
export type TurnRow = typeof sessionTurns.$inferSelect
export type DecisionRow = typeof decisions.$inferSelect
export type TicketInputRow = typeof ticketInputs.$inferSelect
export type BotRow = typeof bots.$inferSelect
export type RoomRow = typeof rooms.$inferSelect
export type RoomMessageRow = typeof roomMessages.$inferSelect
