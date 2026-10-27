ALTER TABLE "app"."interview_counters" ADD COLUMN "transcript_mutation_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."interview_counters" ADD CONSTRAINT "interview_counters_transcript_mutation_nonnegative" CHECK ("app"."interview_counters"."transcript_mutation_version" >= 0);--> statement-breakpoint
ALTER TABLE "app"."durable_jobs" ADD COLUMN "initial_delay_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."durable_jobs" ADD CONSTRAINT "durable_jobs_initial_delay_valid" CHECK ("app"."durable_jobs"."initial_delay_ms" >= 0 AND "app"."durable_jobs"."initial_delay_ms" <= 900000);--> statement-breakpoint
INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")
VALUES ('application', 2, now())
ON CONFLICT ("component") DO UPDATE
SET "version" = EXCLUDED."version", "applied_at" = EXCLUDED."applied_at";
