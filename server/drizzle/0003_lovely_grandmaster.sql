DROP INDEX "session_turns_active_uq";--> statement-breakpoint
ALTER TABLE "session_turns" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_turns" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "session_turns_running_uq" ON "session_turns" USING btree ("session_id") WHERE status = 'running';