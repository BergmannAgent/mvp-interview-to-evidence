CREATE INDEX "interview_state_summary_pagination_idx" ON "app"."interview_state" USING btree ("created_at" DESC NULLS LAST,"interview_id" DESC NULLS LAST);--> statement-breakpoint
INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")
VALUES ('application', 6, now())
ON CONFLICT ("component") DO UPDATE
SET "version" = EXCLUDED."version", "applied_at" = EXCLUDED."applied_at";
