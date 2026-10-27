ALTER TABLE "app"."interview_state"
ADD COLUMN "section_memories" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "app"."interview_state"
ADD CONSTRAINT "interview_state_section_memories_array"
CHECK (jsonb_typeof("section_memories") = 'array');
--> statement-breakpoint
INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")
VALUES ('application', 15, now())
ON CONFLICT ("component") DO UPDATE
SET "version" = EXCLUDED."version", "applied_at" = EXCLUDED."applied_at";
