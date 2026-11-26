CREATE TYPE "public"."mcp_transport" AS ENUM('stdio', 'sse', 'streamable_http');--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"transport" "mcp_transport" DEFAULT 'streamable_http' NOT NULL,
	"endpoint_or_cmd" text NOT NULL,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"default_tool_policy" text DEFAULT 'confirm' NOT NULL,
	"cached_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_health_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"ticket_id" uuid,
	"turn_id" uuid,
	"bot_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"mime_type" text NOT NULL,
	"storage_path" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_turn_id_session_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."session_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_project_name_uq" ON "mcp_servers" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "artifacts_project_time_idx" ON "artifacts" USING btree ("project_id","created_at");
