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
    lastRunId: uuid('last_run_id'),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    createdAt,
    updatedAt,
  },
  (table) => [
    index('tickets_project_status_idx').on(table.projectId, table.status),
    index('tickets_thread_idx').on(table.projectId, table.channelId, table.threadKey),
    index('tickets_created_idx').on(table.createdAt),
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

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    kind: runKindEnum('kind').notNull().default('execute'),
    status: runStatusEnum('status').notNull().default('queued'),
    workerId: text('worker_id'),
    attempt: integer('attempt').notNull().default(1),
    prompt: text('prompt'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),
    tokens: integer('tokens').notNull().default(0),
    cost: numeric('cost', { precision: 12, scale: 6, mode: 'number' }).notNull().default(0),
    logsUrl: text('logs_url'),
    branch: text('branch'),
    prUrl: text('pr_url'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'date' }),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true, mode: 'date' }),
    createdAt,
  },
  (table) => [
    index('runs_ticket_idx').on(table.ticketId, table.createdAt),
    index('runs_project_status_idx').on(table.projectId, table.status),
    uniqueIndex('runs_one_active_per_ticket_uq')
      .on(table.ticketId)
      .where(sql`status in ('queued', 'running')`),
  ],
)

export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    message: text('message'),
    payload: jsonb('payload').$type<unknown>(),
    createdAt,
  },
  (table) => [index('run_events_run_idx').on(table.runId, table.id)],
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
  runs,
  runEvents,
  approvals,
  auditLogs,
  usage,
  outboxEvents,
  webhookDeliveries,
}

export type Schema = typeof schema
export type UserRow = typeof users.$inferSelect
export type ProjectRow = typeof projects.$inferSelect
export type TicketRow = typeof tickets.$inferSelect
export type RunRow = typeof runs.$inferSelect
export type ChannelRow = typeof channels.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type RepoRow = typeof repos.$inferSelect
export type InviteRow = typeof invites.$inferSelect
export type MemberRow = typeof projectMembers.$inferSelect
export type OutboxRow = typeof outboxEvents.$inferSelect
