ALTER TABLE "app"."guides"
ADD COLUMN "source_language" text NOT NULL DEFAULT 'de';
--> statement-breakpoint
ALTER TABLE "app"."guides"
ADD CONSTRAINT "guides_source_language_valid" CHECK ("source_language" in ('de', 'en'));
--> statement-breakpoint
ALTER TABLE "app"."guides"
ADD CONSTRAINT "guides_id_language_unique" UNIQUE ("id", "source_language");
--> statement-breakpoint
ALTER TABLE "app"."interviews"
ADD COLUMN "language" text NOT NULL DEFAULT 'de';
--> statement-breakpoint
ALTER TABLE "app"."interviews"
ADD CONSTRAINT "interviews_language_valid" CHECK ("language" in ('de', 'en'));
--> statement-breakpoint
ALTER TABLE "app"."interviews"
ADD CONSTRAINT "interviews_guide_language_fk"
FOREIGN KEY ("guide_id", "language")
REFERENCES "app"."guides"("id", "source_language") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "app"."event_outbox"
ADD COLUMN "language" text NOT NULL DEFAULT 'de';
--> statement-breakpoint
ALTER TABLE "app"."event_outbox"
ADD CONSTRAINT "event_outbox_language_valid" CHECK ("language" in ('de', 'en'));
--> statement-breakpoint
ALTER TABLE "app"."evaluation_runs"
ADD COLUMN "language" text NOT NULL DEFAULT 'de';
--> statement-breakpoint
ALTER TABLE "app"."evaluation_runs"
ADD CONSTRAINT "evaluation_runs_language_valid" CHECK ("language" in ('de', 'en'));
--> statement-breakpoint
UPDATE "app"."evaluation_runs"
SET "report" = "report" || jsonb_build_object(
  'language', "language",
  'profileTranslation', null
)
WHERE "status" = 'completed' AND NOT ("report" ? 'language');
--> statement-breakpoint
ALTER TABLE "app"."evaluation_runs"
DROP CONSTRAINT "evaluation_runs_completed_report_scope";
--> statement-breakpoint
ALTER TABLE "app"."evaluation_runs"
ADD CONSTRAINT "evaluation_runs_completed_report_scope" CHECK (
  "status" <> 'completed'
  OR "report" @> jsonb_build_object(
    'evaluationId', "evaluation_id",
    'interviewId', "interview_id",
    'profileId', "profile_id",
    'profileFingerprint', "profile_fingerprint",
    'transcriptFingerprint', "transcript_fingerprint",
    'language', "language",
    'promptVersion', "prompt_version",
    'model', "model"
  )
);
--> statement-breakpoint
INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")
VALUES ('application', 14, now())
ON CONFLICT ("component") DO UPDATE
SET "version" = EXCLUDED."version", "applied_at" = EXCLUDED."applied_at";
