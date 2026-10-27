DROP TABLE "app"."evaluation_runs";
--> statement-breakpoint
DROP TABLE "app"."evaluation_rubrics";
--> statement-breakpoint
CREATE TABLE "app"."evaluation_runs" (
	"evaluation_id" text PRIMARY KEY NOT NULL,
	"interview_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"profile_fingerprint" text NOT NULL,
	"transcript_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" jsonb NOT NULL,
	"report" jsonb,
	"failure" jsonb,
	"started_at" timestamp(3) with time zone NOT NULL,
	"ended_at" timestamp(3) with time zone,
	"duration_ms" integer,
	CONSTRAINT "evaluation_runs_interview_profile_unique" UNIQUE("interview_id", "profile_id"),
	CONSTRAINT "evaluation_runs_identity_valid" CHECK (
		"evaluation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
		AND "prompt_version" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
	),
	CONSTRAINT "evaluation_runs_fingerprints_sha256" CHECK (
		"profile_fingerprint" ~ '^[0-9a-f]{64}$'
		AND "transcript_fingerprint" ~ '^[0-9a-f]{64}$'
	),
	CONSTRAINT "evaluation_runs_status_valid" CHECK (
		"status" in ('running', 'completed', 'failed')
	),
	CONSTRAINT "evaluation_runs_model_object" CHECK (jsonb_typeof("model") = 'object'),
	CONSTRAINT "evaluation_runs_terminal_shape" CHECK (
		("status" = 'running' AND "ended_at" IS NULL AND "duration_ms" IS NULL AND "report" IS NULL AND "failure" IS NULL)
		OR ("status" = 'completed' AND "ended_at" IS NOT NULL AND "duration_ms" IS NOT NULL AND "report" IS NOT NULL AND jsonb_typeof("report") = 'object' AND "failure" IS NULL)
		OR ("status" = 'failed' AND "ended_at" IS NOT NULL AND "duration_ms" IS NOT NULL AND "report" IS NULL AND "failure" IS NOT NULL AND jsonb_typeof("failure") = 'object')
	),
	CONSTRAINT "evaluation_runs_timing_valid" CHECK (
		"status" = 'running'
		OR (
			"ended_at" >= "started_at"
			AND "duration_ms" >= 0
			AND "duration_ms" = round(extract(epoch from ("ended_at" - "started_at")) * 1000)::integer
		)
	),
	CONSTRAINT "evaluation_runs_completed_report_scope" CHECK (
		"status" <> 'completed'
		OR "report" @> jsonb_build_object(
			'evaluationId', "evaluation_id",
			'interviewId', "interview_id",
			'profileId', "profile_id",
			'profileFingerprint', "profile_fingerprint",
			'transcriptFingerprint', "transcript_fingerprint",
			'promptVersion', "prompt_version",
			'model', "model"
		)
	)
);
--> statement-breakpoint
ALTER TABLE "app"."evaluation_runs" ADD CONSTRAINT "evaluation_runs_interview_fk"
FOREIGN KEY ("interview_id") REFERENCES "app"."interviews"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "app"."evaluation_runs" ADD CONSTRAINT "evaluation_runs_profile_fk"
FOREIGN KEY ("profile_id") REFERENCES "app"."evaluation_profiles"("profile_id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "evaluation_runs_interview_started_idx"
ON "app"."evaluation_runs" ("interview_id", "started_at" DESC);
--> statement-breakpoint
INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")
VALUES ('application', 13, now())
ON CONFLICT ("component") DO UPDATE
SET "version" = EXCLUDED."version", "applied_at" = EXCLUDED."applied_at";
