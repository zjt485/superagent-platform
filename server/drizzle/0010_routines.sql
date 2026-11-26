DO $$ BEGIN
  CREATE TYPE "public"."routine_trigger_type" AS ENUM('cron', 'webhook', 'repo_event');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "routines" (
  "id" uuid PRIMARY KEY NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "bot_id" uuid REFERENCES "bots"("id") ON DELETE set null,
  "room_id" uuid REFERENCES "rooms"("id") ON DELETE set null,
  "name" text NOT NULL,
  "description" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "trigger_type" "routine_trigger_type" DEFAULT 'cron' NOT NULL,
  "cron_expr" text,
  "timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
  "event_filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "prompt" text NOT NULL,
  "notify_on_quiet" boolean DEFAULT false NOT NULL,
  "max_budget_usd" numeric(10, 4) DEFAULT 1 NOT NULL,
  "next_run_at" timestamp with time zone,
  "last_run_at" timestamp with time zone,
  "last_status" text,
  "last_ticket_id" uuid REFERENCES "tickets"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_due_idx" ON "routines" USING btree ("enabled", "trigger_type", "next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_project_idx" ON "routines" USING btree ("project_id", "created_at");
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "routine_id" uuid REFERENCES "routines"("id") ON DELETE set null;
