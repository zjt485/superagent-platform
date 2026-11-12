CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."approval_kind" AS ENUM('plan', 'merge');--> statement-breakpoint
CREATE TYPE "public"."channel_provider" AS ENUM('feishu', 'wecom');--> statement-breakpoint
CREATE TYPE "public"."channel_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."intake_action" AS ENUM('ticket_created', 'ticket_appended', 'command', 'ignored', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'maintainer', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."run_kind" AS ENUM('plan', 'execute');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('new', 'triaged', 'planned', 'running', 'waiting_review', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"kind" "approval_kind" NOT NULL,
	"actor_id" uuid,
	"decision" "approval_decision" NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"actor_id" uuid,
	"actor_label" text,
	"action" text NOT NULL,
	"target" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" "channel_provider" NOT NULL,
	"external_chat_id" text NOT NULL,
	"name" text,
	"status" "channel_status" DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"action" "intake_action" NOT NULL,
	"reason" text,
	"command" text,
	"ticket_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer DEFAULT 50 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"channel_id" uuid,
	"provider" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"sender_id" uuid,
	"external_sender_id" text,
	"sender_name" text,
	"text" text NOT NULL,
	"thread_key" text,
	"reply_to_message_id" text,
	"is_bot" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"channel_id" uuid,
	"kind" text NOT NULL,
	"dedupe_key" text,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"installation_id" text NOT NULL,
	"account_login" text,
	"account_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"status" "project_status" DEFAULT 'draft' NOT NULL,
	"policy_json" jsonb NOT NULL,
	"model_config" jsonb NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"installation_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"private" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"type" text NOT NULL,
	"message" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"kind" "run_kind" DEFAULT 'execute' NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"worker_id" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"prompt" text,
	"result" jsonb,
	"error" text,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost" numeric(12, 6) DEFAULT 0 NOT NULL,
	"logs_url" text,
	"branch" text,
	"pr_url" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"channel_id" uuid,
	"thread_key" text,
	"requester_id" uuid,
	"requester_name" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" "ticket_status" DEFAULT 'new' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'normal' NOT NULL,
	"plan" text,
	"plan_approved_at" timestamp with time zone,
	"pr_url" text,
	"branch" text,
	"last_run_id" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"day" date NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"cost" numeric(14, 6) DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"avatar" text,
	"email" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_installations" ADD CONSTRAINT "project_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_ticket_idx" ON "approvals" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "audit_logs_project_idx" ON "audit_logs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_uq" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_provider_chat_uq" ON "channels" USING btree ("provider","external_chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_active_project_uq" ON "channels" USING btree ("project_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "identities_provider_external_uq" ON "identities" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "identities_user_idx" ON "identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_events_message_uq" ON "intake_events" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "intake_events_project_idx" ON "intake_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_uq" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invites_project_idx" ON "invites" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_message_uq" ON "messages" USING btree ("provider","provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("project_id","channel_id","thread_key");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedupe_uq" ON "outbox_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_installations_uq" ON "project_installations" USING btree ("project_id","installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_members_uq" ON "project_members" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "project_members_user_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_uq" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "projects_owner_idx" ON "projects" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_project_uq" ON "repos" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "repos_full_name_idx" ON "repos" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "run_events_run_idx" ON "run_events" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "runs_ticket_idx" ON "runs" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_project_status_idx" ON "runs" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_ticket_uq" ON "runs" USING btree ("ticket_id") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "tickets_project_status_idx" ON "tickets" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "tickets_thread_idx" ON "tickets" USING btree ("project_id","channel_id","thread_key");--> statement-breakpoint
CREATE INDEX "tickets_created_idx" ON "tickets" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_project_day_uq" ON "usage" USING btree ("project_id","day");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_uq" ON "webhook_deliveries" USING btree ("provider","delivery_id");