CREATE TYPE "public"."action_approval_risk" AS ENUM('medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."action_approval_status" AS ENUM('pending', 'approved', 'rejected', 'revision_requested', 'expired');--> statement-breakpoint
ALTER TYPE "public"."turn_status" ADD VALUE IF NOT EXISTS 'waiting_approval';--> statement-breakpoint
CREATE TABLE "action_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"room_id" uuid,
	"ticket_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"bot_id" uuid,
	"tool_name" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"risk_level" "action_approval_risk" DEFAULT 'medium' NOT NULL,
	"title" text NOT NULL,
	"preview" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "action_approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decision_comment" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"im_message_ref" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "session_turns" ADD COLUMN "checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "session_turns" ADD COLUMN "paused_approval_id" uuid;--> statement-breakpoint
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_turn_id_session_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."session_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_approvals_project_status_idx" ON "action_approvals" USING btree ("project_id","status","created_at");--> statement-breakpoint
CREATE INDEX "action_approvals_ticket_idx" ON "action_approvals" USING btree ("ticket_id");
