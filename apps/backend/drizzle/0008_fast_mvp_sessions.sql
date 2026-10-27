CREATE TABLE "app"."mvp_interview_sessions" (
  "interview_id" text PRIMARY KEY NOT NULL,
  "status" text DEFAULT 'ready' NOT NULL,
  "current_question_index" integer DEFAULT 0 NOT NULL,
  "next_sequence_number" integer DEFAULT 1 NOT NULL,
  "partial_text" text,
  "partial_updated_at" timestamp(3) with time zone,
  "started_at" timestamp(3) with time zone,
  "ended_at" timestamp(3) with time zone,
  "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mvp_interview_sessions_status_valid" CHECK ("status" in ('ready', 'active', 'paused', 'completed')),
  CONSTRAINT "mvp_interview_sessions_question_index_nonnegative" CHECK ("current_question_index" >= 0),
  CONSTRAINT "mvp_interview_sessions_sequence_positive" CHECK ("next_sequence_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."mvp_transcript_turns" (
  "interview_id" text NOT NULL,
  "sequence_number" integer NOT NULL,
  "turn_id" text NOT NULL,
  "speaker" text NOT NULL,
  "turn_type" text NOT NULL,
  "text" text NOT NULL,
  "question_id" text,
  "provider_event_id" text,
  "source_provider" text,
  "occurred_at" timestamp(3) with time zone NOT NULL,
  CONSTRAINT "mvp_transcript_turns_pk" PRIMARY KEY("interview_id", "sequence_number"),
  CONSTRAINT "mvp_transcript_turns_id_unique" UNIQUE("interview_id", "turn_id"),
  CONSTRAINT "mvp_transcript_turns_provider_event_unique" UNIQUE("interview_id", "provider_event_id"),
  CONSTRAINT "mvp_transcript_turns_sequence_positive" CHECK ("sequence_number" > 0),
  CONSTRAINT "mvp_transcript_turns_speaker_valid" CHECK ("speaker" in ('ai_interviewer', 'participant')),
  CONSTRAINT "mvp_transcript_turns_type_valid" CHECK ("turn_type" in ('greeting', 'main_question', 'follow_up_question', 'participant_answer', 'closing')),
  CONSTRAINT "mvp_transcript_turns_text_not_blank" CHECK (btrim("text") <> '')
);
--> statement-breakpoint
ALTER TABLE "app"."mvp_interview_sessions" ADD CONSTRAINT "mvp_interview_sessions_interview_fk" FOREIGN KEY ("interview_id") REFERENCES "app"."interviews"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "app"."mvp_transcript_turns" ADD CONSTRAINT "mvp_transcript_turns_interview_fk" FOREIGN KEY ("interview_id") REFERENCES "app"."interviews"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "mvp_transcript_turns_interview_time_idx" ON "app"."mvp_transcript_turns" ("interview_id", "sequence_number");
--> statement-breakpoint
INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")
VALUES ('application', 9, now())
ON CONFLICT ("component") DO UPDATE
SET "version" = EXCLUDED."version", "applied_at" = EXCLUDED."applied_at";
