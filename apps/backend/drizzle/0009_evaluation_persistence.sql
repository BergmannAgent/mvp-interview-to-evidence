CREATE TABLE "app"."evaluation_rubrics" (
  "rubric_id" text NOT NULL,
  "version" integer NOT NULL,
  "guide_id" text NOT NULL,
  "schema_version" integer NOT NULL,
  "fingerprint" text NOT NULL,
  "rubric" jsonb NOT NULL,
  "stored_at" timestamp(3) with time zone NOT NULL,
  CONSTRAINT "evaluation_rubrics_pk" PRIMARY KEY("rubric_id", "version"),
  CONSTRAINT "evaluation_rubrics_scope_unique" UNIQUE("rubric_id", "version", "guide_id", "fingerprint"),
  CONSTRAINT "evaluation_rubrics_identity_valid" CHECK ("rubric_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT "evaluation_rubrics_version_positive" CHECK ("version" > 0),
  CONSTRAINT "evaluation_rubrics_schema_version_v1" CHECK ("schema_version" = 1),
  CONSTRAINT "evaluation_rubrics_fingerprint_sha256" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "evaluation_rubrics_json_scope" CHECK (
    jsonb_typeof("rubric") = 'object'
    AND "rubric" @> jsonb_build_object(
      'schemaVersion', "schema_version",
      'rubricId', "rubric_id",
      'guideId', "guide_id",
      'version', "version"
    )
  )
);
--> statement-breakpoint
CREATE TABLE "app"."evaluation_runs" (
  "evaluation_id" text PRIMARY KEY NOT NULL,
  "interview_id" text NOT NULL,
  "guide_id" text NOT NULL,
  "rubric_id" text NOT NULL,
  "rubric_version" integer NOT NULL,
  "rubric_fingerprint" text NOT NULL,
  "transcript_fingerprint" text NOT NULL,
  "status" text NOT NULL,
  "prompt_version" text NOT NULL,
  "model" jsonb NOT NULL,
  "report" jsonb,
  "failure" jsonb,
  "started_at" timestamp(3) with time zone NOT NULL,
  "ended_at" timestamp(3) with time zone,
  "duration_ms" integer,
  CONSTRAINT "evaluation_runs_source_unique" UNIQUE("interview_id", "rubric_fingerprint", "transcript_fingerprint"),
  CONSTRAINT "evaluation_runs_identity_valid" CHECK (
    "evaluation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND "prompt_version" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT "evaluation_runs_rubric_version_positive" CHECK ("rubric_version" > 0),
  CONSTRAINT "evaluation_runs_fingerprints_sha256" CHECK (
    "rubric_fingerprint" ~ '^[0-9a-f]{64}$'
    AND "transcript_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "evaluation_runs_status_valid" CHECK ("status" in ('running', 'completed', 'failed')),
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
      'guideId', "guide_id",
      'rubricId', "rubric_id",
      'rubricVersion', "rubric_version",
      'rubricFingerprint', "rubric_fingerprint",
      'transcriptFingerprint', "transcript_fingerprint",
      'promptVersion', "prompt_version",
      'model', "model"
    )
  )
);
--> statement-breakpoint
ALTER TABLE "app"."evaluation_rubrics" ADD CONSTRAINT "evaluation_rubrics_guide_fk" FOREIGN KEY ("guide_id") REFERENCES "app"."guides"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "app"."evaluation_runs" ADD CONSTRAINT "evaluation_runs_interview_fk" FOREIGN KEY ("interview_id", "guide_id") REFERENCES "app"."interviews"("id", "guide_id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "app"."evaluation_runs" ADD CONSTRAINT "evaluation_runs_rubric_fk" FOREIGN KEY ("rubric_id", "rubric_version", "guide_id", "rubric_fingerprint") REFERENCES "app"."evaluation_rubrics"("rubric_id", "version", "guide_id", "fingerprint") ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX "evaluation_runs_interview_started_idx" ON "app"."evaluation_runs" ("interview_id", "started_at" DESC);
--> statement-breakpoint
INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")
VALUES ('application', 10, now())
ON CONFLICT ("component") DO UPDATE
SET "version" = EXCLUDED."version", "applied_at" = EXCLUDED."applied_at";
