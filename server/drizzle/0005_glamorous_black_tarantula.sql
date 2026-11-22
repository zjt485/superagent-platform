CREATE TYPE "public"."decision_action" AS ENUM('new', 'attach', 'ignore', 'stop', 'command');--> statement-breakpoint
CREATE TYPE "public"."input_kind" AS ENUM('message', 'approval', 'policy', 'note', 'system');--> statement-breakpoint
CREATE TYPE "public"."trigger_address" AS ENUM('mention', 'direct', 'ambient');--> statement-breakpoint
CREATE TYPE "public"."trigger_disposition" AS ENUM('pending', 'attached', 'new_ticket', 'ignored', 'stopped', 'command', 'pending_review');--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"trigger_id" uuid NOT NULL,
	"thread_key" text,
	"action" "decision_action" NOT NULL,
	"ticket_id" uuid,
	"title" text,
	"reason" text NOT NULL,
	"confidence" numeric(4, 2),
	"payload" jsonb,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"channel_id" uuid,
	"thread_key" text NOT NULL,
	"summary" text,
	"router_pending" boolean DEFAULT false NOT NULL,
	"router_lease_until" timestamp with time zone,
	"last_trigger_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "session_turns" ADD COLUMN "seq" integer;--> statement-breakpoint
ALTER TABLE "session_turns" ADD COLUMN "pid" integer;--> statement-breakpoint
ALTER TABLE "session_turns" ADD COLUMN "exit_code" integer;--> statement-breakpoint
ALTER TABLE "ticket_inputs" ADD COLUMN "kind" "input_kind" DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_inputs" ADD COLUMN "delivered_turn_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "short_name" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "worktree_path" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "base_ref" text;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "disposition" "trigger_disposition" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "address" "trigger_address" DEFAULT 'mention' NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_run_id_evaluations_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_trigger_id_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_trigger_uq" ON "decisions" USING btree ("trigger_id");--> statement-breakpoint
CREATE INDEX "decisions_run_idx" ON "decisions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "decisions_project_time_idx" ON "decisions" USING btree ("project_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_key_uq" ON "threads" USING btree ("project_id","channel_id","thread_key");--> statement-breakpoint
CREATE INDEX "threads_pending_idx" ON "threads" USING btree ("router_pending","router_lease_until");--> statement-breakpoint
ALTER TABLE "ticket_inputs" ADD CONSTRAINT "ticket_inputs_delivered_turn_id_session_turns_id_fk" FOREIGN KEY ("delivered_turn_id") REFERENCES "public"."session_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_turns_ticket_seq_uq" ON "session_turns" USING btree ("ticket_id","seq") WHERE ticket_id is not null and seq is not null;--> statement-breakpoint
CREATE INDEX "ticket_inputs_turn_idx" ON "ticket_inputs" USING btree ("delivered_turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_short_name_uq" ON "tickets" USING btree ("project_id","short_name") WHERE short_name is not null;--> statement-breakpoint
CREATE INDEX "triggers_pending_idx" ON "triggers" USING btree ("project_id","disposition","created_at");