CREATE TYPE "public"."assignment_status" AS ENUM('pending', 'running', 'ended');--> statement-breakpoint
CREATE TYPE "public"."evaluation_status" AS ENUM('queued', 'running', 'decided', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."input_source" AS ENUM('trigger', 'person', 'note', 'policy', 'approval', 'system');--> statement-breakpoint
CREATE TYPE "public"."mandate_strength" AS ENUM('explicit', 'inferred');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."session_role" AS ENUM('main', 'executor');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('idle', 'queued', 'running', 'error');--> statement-breakpoint
CREATE TYPE "public"."subscription_kind" AS ENUM('own', 'context');--> statement-breakpoint
CREATE TYPE "public"."trigger_kind" AS ENUM('message', 'command', 'ci', 'pr_comment', 'pr_merge', 'pr_close', 'resume');--> statement-breakpoint
CREATE TYPE "public"."turn_kind" AS ENUM('eval', 'execute', 'resume');--> statement-breakpoint
CREATE TYPE "public"."turn_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout');--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"role" "session_role" NOT NULL,
	"ticket_id" uuid,
	"status" "session_status" DEFAULT 'idle' NOT NULL,
	"model" text,
	"preset" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_turn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"status" "assignment_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"channel_id" uuid,
	"thread_key" text NOT NULL,
	"policy_version" text NOT NULL,
	"status" "evaluation_status" DEFAULT 'queued' NOT NULL,
	"trigger_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" jsonb,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"strength" "mandate_strength" NOT NULL,
	"scope" text NOT NULL,
	"matched_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"basis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requester_trigger_id" uuid,
	"requester_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"assignment_id" uuid,
	"turn_id" uuid,
	"status" "report_status" NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"plan" text,
	"attention_question" text,
	"attention_answered_at" timestamp with time zone,
	"branch" text,
	"pr_url" text,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost" numeric(12, 6) DEFAULT 0 NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" uuid,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"ticket_id" uuid,
	"evaluation_id" uuid,
	"assignment_id" uuid,
	"kind" "turn_kind" NOT NULL,
	"status" "turn_status" DEFAULT 'queued' NOT NULL,
	"input" jsonb,
	"prompt" text,
	"result" jsonb,
	"error" text,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost" numeric(12, 6) DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_inputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"trigger_id" uuid,
	"source" "input_source" NOT NULL,
	"text" text NOT NULL,
	"is_person" boolean DEFAULT false NOT NULL,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"channel_id" uuid,
	"thread_key" text NOT NULL,
	"kind" "subscription_kind" DEFAULT 'own' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"channel_id" uuid,
	"message_id" uuid,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" "trigger_kind" DEFAULT 'message' NOT NULL,
	"thread_key" text,
	"actor_user_id" uuid,
	"actor_external_id" text,
	"actor_name" text,
	"text" text NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"mentioned_bot" boolean DEFAULT false NOT NULL,
	"reply_to" text,
	"raw" jsonb,
	"evaluation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turn_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"type" text NOT NULL,
	"message" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "policy_version" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "origin_trigger_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "last_report_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "ended_reason" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_requester_trigger_id_triggers_id_fk" FOREIGN KEY ("requester_trigger_id") REFERENCES "public"."triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_turn_id_session_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."session_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_turn_id_session_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."session_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_inputs" ADD CONSTRAINT "ticket_inputs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_inputs" ADD CONSTRAINT "ticket_inputs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_inputs" ADD CONSTRAINT "ticket_inputs_trigger_id_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_subscriptions" ADD CONSTRAINT "ticket_subscriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_subscriptions" ADD CONSTRAINT "ticket_subscriptions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_subscriptions" ADD CONSTRAINT "ticket_subscriptions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_events" ADD CONSTRAINT "turn_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_events" ADD CONSTRAINT "turn_events_turn_id_session_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."session_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_main_uq" ON "agent_sessions" USING btree ("project_id") WHERE role = 'main';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_executor_uq" ON "agent_sessions" USING btree ("ticket_id") WHERE role = 'executor';--> statement-breakpoint
CREATE INDEX "agent_sessions_project_role_idx" ON "agent_sessions" USING btree ("project_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_active_uq" ON "assignments" USING btree ("ticket_id") WHERE status in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "assignments_ticket_idx" ON "assignments" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluations_active_uq" ON "evaluations" USING btree ("project_id","channel_id","thread_key") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "evaluations_project_status_idx" ON "evaluations" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "mandates_ticket_uq" ON "mandates" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "reports_ticket_idx" ON "reports" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "session_messages_session_idx" ON "session_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_turns_active_uq" ON "session_turns" USING btree ("session_id") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "session_turns_queue_idx" ON "session_turns" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "session_turns_ticket_idx" ON "session_turns" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "ticket_inputs_ticket_idx" ON "ticket_inputs" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_subscriptions_uq" ON "ticket_subscriptions" USING btree ("ticket_id","provider","thread_key");--> statement-breakpoint
CREATE INDEX "ticket_subscriptions_thread_idx" ON "ticket_subscriptions" USING btree ("project_id","provider","thread_key");--> statement-breakpoint
CREATE UNIQUE INDEX "triggers_provider_external_uq" ON "triggers" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "triggers_thread_idx" ON "triggers" USING btree ("project_id","channel_id","thread_key");--> statement-breakpoint
CREATE INDEX "triggers_project_created_idx" ON "triggers" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "turn_events_turn_idx" ON "turn_events" USING btree ("turn_id","id");