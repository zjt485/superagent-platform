CREATE TYPE "public"."bot_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."bot_sandbox_state" AS ENUM('stopped', 'starting', 'running', 'error');--> statement-breakpoint
CREATE TYPE "public"."room_kind" AS ENUM('group', 'dm', 'routine_feed');--> statement-breakpoint
CREATE TYPE "public"."room_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."room_author_kind" AS ENUM('user', 'bot', 'system');--> statement-breakpoint
CREATE TYPE "public"."room_message_kind" AS ENUM('chat', 'handoff', 'status', 'approval_card', 'artifact', 'report');--> statement-breakpoint
ALTER TYPE "public"."trigger_kind" ADD VALUE IF NOT EXISTS 'handoff';--> statement-breakpoint
ALTER TYPE "public"."trigger_kind" ADD VALUE IF NOT EXISTS 'routine';--> statement-breakpoint
CREATE TABLE "bots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"role_title" text NOT NULL,
	"avatar" text,
	"status" "bot_status" DEFAULT 'active' NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"model_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sandbox_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"im_binding" jsonb,
	"sandbox_state" "bot_sandbox_state" DEFAULT 'stopped' NOT NULL,
	"container_id" text,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "room_kind" DEFAULT 'group' NOT NULL,
	"name" text NOT NULL,
	"topic" text,
	"channel_id" uuid,
	"dm_user_id" uuid,
	"default_bot_id" uuid,
	"max_handoff_hops" integer DEFAULT 5 NOT NULL,
	"status" "room_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "room_bots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "room_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"thread_key" text NOT NULL,
	"author_kind" "room_author_kind" NOT NULL,
	"author_user_id" uuid,
	"author_bot_id" uuid,
	"kind" "room_message_kind" DEFAULT 'chat' NOT NULL,
	"content" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ticket_id" uuid,
	"turn_id" uuid,
	"reply_to_id" uuid,
	"external_provider" text,
	"external_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "bot_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "room_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "handoff_chain_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "handoff_hop" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "parent_ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "room_id" uuid;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "target_bot_id" uuid;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "source_bot_id" uuid;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "handoff_chain_id" uuid;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "handoff_hop" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_turns" ADD COLUMN "bot_id" uuid;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_dm_user_id_users_id_fk" FOREIGN KEY ("dm_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_default_bot_id_bots_id_fk" FOREIGN KEY ("default_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_bots" ADD CONSTRAINT "room_bots_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_bots" ADD CONSTRAINT "room_bots_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_author_bot_id_bots_id_fk" FOREIGN KEY ("author_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_turn_id_session_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."session_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_target_bot_id_bots_id_fk" FOREIGN KEY ("target_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_source_bot_id_bots_id_fk" FOREIGN KEY ("source_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bots_project_slug_uq" ON "bots" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "bots_project_status_idx" ON "bots" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "rooms_project_idx" ON "rooms" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "rooms_channel_idx" ON "rooms" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_bots_uq" ON "room_bots" USING btree ("room_id","bot_id");--> statement-breakpoint
CREATE INDEX "room_messages_room_time_idx" ON "room_messages" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "room_messages_external_uq" ON "room_messages" USING btree ("external_provider","external_message_id") WHERE external_provider is not null and external_message_id is not null;
